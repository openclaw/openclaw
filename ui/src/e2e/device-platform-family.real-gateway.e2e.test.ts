import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateConnectParams, type ConnectParams } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import type { Locator } from "playwright";
import { expect, inject, it } from "vitest";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../../src/infra/device-identity.js";
import { approveDevicePairing } from "../../../src/infra/device-pairing-approval.js";
import {
  listDevicePairing,
  rejectDevicePairing,
  type PairedDevice,
} from "../../../src/infra/device-pairing.js";
import {
  startBuiltControlUiE2eServer,
  startProductionControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  approvePairing,
  createDeviceGateway,
  readUiBundle,
} from "./device-gateway.test-support.ts";

const readText = async (locator: Locator) =>
  expectDefined(await locator.textContent(), "UI text").trim();
const readPaired = async (deviceId: string) =>
  (await listDevicePairing()).paired.find((row) => row.deviceId === deviceId);

async function waitConnected(row: Locator) {
  await row.waitFor();
  await expect.poll(() => readText(row.locator(".device-entry__status"))).toBe("connected");
}

const macUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const ipadUa = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const cases = (
  [
    ["fresh-mac", 0, macUa, false, "Mac", "macOS"],
    ["fresh-ipad-touch", 5, macUa, false, "iPad", "iPadOS"],
    ["fresh-ipad-agent", 0, ipadUa, false, "iPad", "iPadOS"],
    ["legacy-mac", 0, macUa, true, "Mac", "macOS"],
    ["legacy-ipad", 5, macUa, true, "iPad", "iPadOS"],
  ] as const
).map(([name, touch, ua, legacy, family, label]) => ({ name, touch, ua, legacy, family, label }));
let sourceBuildMetadata = "synthetic; use source revision and asset hash";
const suite = createControlUiE2eSuite({
  name: "Control UI browser platform family with a real Gateway",
  setupTimeoutMs: 180_000,
  startServerBeforeBrowser: true,
  startServer: async () => {
    const prebuiltAssets = inject("controlUiE2ePrebuiltAssets");
    if (prebuiltAssets) {
      sourceBuildMetadata = `validated prebuilt Control UI ${prebuiltAssets.buildInfo.buildId}; use source revision and asset hash`;
      return startBuiltControlUiE2eServer(prebuiltAssets.root);
    }
    const out = path.join(suite.artifactDir, "production-ui");
    await mkdir(out, { recursive: true });
    return startProductionControlUiE2eServer(out, "synthetic-platform-proof-build-id");
  },
});
const identityFacts = (row: ReturnType<typeof pairedFacts>) =>
  row && {
    deviceId: row.deviceId,
    publicKey: row.publicKey,
    approvedAtMs: row.approvedAtMs,
    createdAtMs: row.createdAtMs,
    roles: row.roles,
    scopes: row.scopes,
  };
const pairedFacts = (row: PairedDevice | undefined) =>
  row && {
    deviceId: row.deviceId,
    publicKey: row.publicKey,
    platform: row.platform,
    deviceFamily: row.deviceFamily,
    approvedAtMs: row.approvedAtMs,
    createdAtMs: row.createdAtMs,
    roles: row.roles,
    scopes: row.scopes,
  };
const writeProof = (name: string, value: unknown) =>
  writeFile(path.join(suite.artifactDir, name), JSON.stringify(value, null, 2));

suite.define(() => {
  it("keeps signed browser identities while rendering fresh and legacy Mac and iPad labels", async (context) => {
    const token = "synthetic-platform-gateway-token";
    // Keep identity proof independent of host installation discovery.
    const gateway = await createDeviceGateway(
      "platform-family-proof",
      suite.server.baseUrl,
      { mode: "token", token },
      { update: { channel: "stable" } },
    );
    const { state, port } = gateway;
    const observations: {
      name: string;
      expectedFamily: string;
      legacy: boolean;
      after: ReturnType<typeof pairedFacts>;
      meta: string;
      connects: ConnectParams[];
      assetHash: string;
      sourceBuildMetadata: string;
      pendingCount: number;
    }[] = [];
    await suite.runScenario(context, {
      retainedState: () => state.root,
      async run() {
        await gateway.configure();
        const orphan = loadOrCreateDeviceIdentity({
          path: path.join(state.stateDir, "legacy-device.sqlite"),
        });
        await approvePairing({
          deviceId: orphan.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(orphan.publicKeyPem),
          role: "operator",
          scopes: ["operator.read"],
          clientId: "legacy-platform-fixture",
          clientMode: "cli",
          platform: "MacIntel",
          displayName: "Disconnected legacy browser",
        });
        await gateway.start();
        for (const item of cases) {
          await suite.withPage(
            { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
            async ({ page }) => {
              await page.addInitScript(({ touch, ua }) => {
                for (const [key, value] of Object.entries({
                  platform: "MacIntel",
                  maxTouchPoints: touch,
                  userAgent: ua,
                })) {
                  Object.defineProperty(navigator, key, { configurable: true, get: () => value });
                }
              }, item);
              const connects: ConnectParams[] = [];
              const outcomes: { ok: boolean; error?: { details?: { reason?: string } } }[] = [];
              const pendingApprovals: Promise<unknown>[] = [];
              let seeded: ReturnType<typeof pairedFacts>;
              let deviceId = "";
              const requestMethods = new Map<string, string>();
              await page.routeWebSocket(`ws://127.0.0.1:${port}/**`, (socket) => {
                const server = socket.connectToServer();
                socket.onMessage(async (message) => {
                  const frame = JSON.parse(String(message));
                  if (frame.type === "req") {
                    requestMethods.set(frame.id, frame.method);
                  }
                  if (frame.type === "req" && frame.method === "connect") {
                    const params = frame.params;
                    if (!validateConnectParams(params)) {
                      throw new Error("Browser sent invalid connect parameters");
                    }
                    if (!params.device) {
                      throw new Error("Browser omitted signed device proof");
                    }
                    deviceId = params.device.id;
                    connects.push({ ...params, auth: undefined });
                    if (item.legacy && !seeded) {
                      await approvePairing({
                        deviceId,
                        publicKey: params.device.publicKey,
                        role: params.role,
                        scopes: params.scopes,
                        clientId: params.client.id,
                        clientMode: params.client.mode,
                        platform: params.client.platform,
                        displayName: item.name,
                      });
                      seeded = pairedFacts(await readPaired(deviceId));
                    }
                  }
                  server.send(message);
                });
                server.onMessage((message) => {
                  const frame = JSON.parse(String(message));
                  if (frame.type === "res" && requestMethods.get(frame.id) === "connect") {
                    outcomes.push({ ok: frame.ok, error: frame.error });
                  }
                  if (
                    frame.type === "res" &&
                    !frame.ok &&
                    requestMethods.get(frame.id) === "connect" &&
                    !item.legacy
                  ) {
                    pendingApprovals.push(
                      (async () => {
                        const own = (await listDevicePairing()).pending.find(
                          (row) => row.deviceId === deviceId,
                        );
                        if (own) {
                          await approveDevicePairing(own.requestId, {
                            callerScopes: ["operator.admin"],
                          });
                        }
                      })(),
                    );
                  }
                  socket.send(message);
                });
              });
              const url = new URL("settings/devices", suite.server.baseUrl);
              url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
              url.hash = `token=${token}`;
              await page.goto(url.toString());
              const confirmation = page.locator("openclaw-gateway-url-confirmation");
              await confirmation.waitFor();
              await confirmation.getByRole("button", { name: /^Switch to / }).click();
              await expect.poll(() => deviceId).not.toBe("");
              const row = page.locator(".device-entry", {
                has: page.locator(`dd[title="${deviceId}"]`),
              });
              await waitConnected(row);
              await Promise.all(pendingApprovals);
              const paired = await readPaired(deviceId);
              await row.screenshot({
                path: path.join(suite.artifactDir, `${item.name}-before-reload.png`),
                animations: "disabled",
              });
              const { sha256: assetHash } = await readUiBundle(page);
              const beforeCount = connects.length;
              await page.reload();
              await expect.poll(() => connects.length).toBeGreaterThan(beforeCount);
              await waitConnected(row);
              const afterList = await listDevicePairing();
              const after = afterList.paired.find((entry) => entry.deviceId === deviceId);
              const meta = await readText(row.locator(".device-entry__body > .settings-row__desc"));
              await row.screenshot({
                path: path.join(suite.artifactDir, `${item.name}-after-reload.png`),
                animations: "disabled",
              });
              expect(identityFacts(after)).toEqual(identityFacts(paired));
              expect(afterList.pending).toEqual([]);
              expect(after?.platform).toBe("MacIntel");
              expect(
                connects.every(
                  (frame) =>
                    frame.client.platform === "MacIntel" && Boolean(frame.device?.signature),
                ),
              ).toBe(true);
              if (item.legacy) {
                expect(identityFacts(after)).toEqual(identityFacts(seeded));
                expect(after?.deviceFamily).toBeUndefined();
              }
              const orphanRow = page.locator(".device-entry", {
                has: page.locator(`dd[title="${orphan.deviceId}"]`),
              });
              expect(
                await readText(orphanRow.locator(".device-entry__body > .settings-row__desc")),
              ).toContain("MacIntel");
              observations.push({
                name: item.name,
                legacy: item.legacy,
                expectedFamily: item.family,
                after: pairedFacts(after),
                meta,
                connects,
                assetHash,
                sourceBuildMetadata,
                pendingCount: afterList.pending.length,
              });
              await writeProof("observations.json", observations);
              if (item === cases.at(-1)) {
                await orphanRow.locator(".device-entry__menu-trigger").click();
                await orphanRow.locator('[role="menuitem"][data-value="remove"]').click();
                await page
                  .locator("openclaw-modal-dialog")
                  .last()
                  .getByRole("button", { name: "Remove", exact: true })
                  .click();
                await expect
                  .poll(async () =>
                    (await listDevicePairing()).paired.some(
                      (entry) => entry.deviceId === orphan.deviceId,
                    ),
                  )
                  .toBe(false);
                const remaining = (await listDevicePairing()).paired;
                expect(remaining.map((entry) => entry.deviceId).toSorted()).toEqual(
                  afterList.paired
                    .filter((entry) => entry.deviceId !== orphan.deviceId)
                    .map((entry) => entry.deviceId)
                    .toSorted(),
                );
                await writeProof("removal.json", {
                  removed: orphan.deviceId,
                  remaining: remaining.map(pairedFacts),
                });
                const current = expectDefined(after, "current paired browser");
                await approvePairing({
                  deviceId,
                  publicKey: current.publicKey,
                  role: "operator",
                  scopes: current.scopes,
                  clientId: "openclaw-control-ui",
                  clientMode: "webchat",
                  platform: "MacIntel",
                  deviceFamily: "Mac",
                });
                const pinned = await readPaired(deviceId);
                const outcomeStart = outcomes.length;
                await page.reload();
                await expect
                  .poll(() =>
                    outcomes
                      .slice(outcomeStart)
                      .some((result) => result.error?.details?.reason === "metadata-upgrade"),
                  )
                  .toBe(true);
                const rejected = await listDevicePairing();
                const request = expectDefined(
                  rejected.pending.find((entry) => entry.deviceId === deviceId),
                  "metadata approval request",
                );
                const retained = rejected.paired.find((entry) => entry.deviceId === deviceId);
                expect(request).toMatchObject({ silent: false, deviceFamily: "iPad" });
                expect(identityFacts(retained)).toEqual(identityFacts(pinned));
                expect(retained?.deviceFamily).toBe("Mac");
                expect(outcomes.slice(outcomeStart).every((result) => !result.ok)).toBe(true);
                await writeProof("metadata-upgrade-rejection.json", {
                  pinned: pairedFacts(pinned),
                  retained: pairedFacts(retained),
                  pending: { silent: request.silent, deviceFamily: request.deviceFamily },
                  outcomes: outcomes.slice(outcomeStart),
                });
                await rejectDevicePairing(request.requestId);
              }
            },
          );
        }
        expect(
          observations.map((row) => ({ name: row.name, label: row.meta.split(" · ")[0] })),
        ).toEqual(cases.map((row) => ({ name: row.name, label: row.label })));
        for (const row of observations) {
          const frames = row.connects;
          expect(frames.every((frame) => frame.client.deviceFamily === row.expectedFamily)).toBe(
            true,
          );
          if (!row.legacy) {
            expect(row.after?.deviceFamily).toBe(row.expectedFamily);
          }
        }
      },
      close: async () => {
        await gateway.close();
      },
      release: async () => {
        await state.cleanup();
      },
    });
  }, 120_000);
});
