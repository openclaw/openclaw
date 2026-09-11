import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateConnectParams, type ConnectParams } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../../src/infra/device-identity.js";
import { approveDevicePairing } from "../../../src/infra/device-pairing-approval.js";
import {
  listDevicePairing,
  requestDevicePairing,
  rejectDevicePairing,
  type PairedDevice,
} from "../../../src/infra/device-pairing.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { startProductionControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const readText = async (locator: Locator) =>
  expectDefined(await locator.textContent(), "UI text").trim();

const cases = [
  {
    name: "fresh-mac",
    touch: 0,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    legacy: false,
    family: "Mac",
    label: "macOS",
  },
  {
    name: "fresh-ipad-touch",
    touch: 5,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    legacy: false,
    family: "iPad",
    label: "iPadOS",
  },
  {
    name: "fresh-ipad-agent",
    touch: 0,
    ua: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
    legacy: false,
    family: "iPad",
    label: "iPadOS",
  },
  {
    name: "legacy-mac",
    touch: 0,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    legacy: true,
    family: "Mac",
    label: "macOS",
  },
  {
    name: "legacy-ipad",
    touch: 5,
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    legacy: true,
    family: "iPad",
    label: "iPadOS",
  },
];
const suite = createControlUiE2eSuite({
  name: "Control UI browser platform family with a real Gateway",
  setupTimeoutMs: 180_000,
  startServerBeforeBrowser: true,
  startServer: async () => {
    const out = path.join(suite.artifactDir, "production-ui");
    await mkdir(out, { recursive: true });
    return startProductionControlUiE2eServer(out, "synthetic-platform-proof-build-id");
  },
});
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
const identityFacts = (row: PairedDevice | undefined) =>
  row && {
    deviceId: row.deviceId,
    publicKey: row.publicKey,
    approvedAtMs: row.approvedAtMs,
    createdAtMs: row.createdAtMs,
    roles: row.roles,
    scopes: row.scopes,
  };

suite.define(() => {
  it("keeps signed browser identities while rendering fresh and legacy Mac and iPad labels", async (context) => {
    const port = await getFreePort();
    const token = "synthetic-platform-gateway-token";
    const state = await createOpenClawTestState({
      label: "platform-family-proof",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    const observations: {
      name: string;
      expectedFamily: string;
      expectedLabel: string;
      legacy: boolean;
      first: unknown;
      after: ReturnType<typeof pairedFacts>;
      meta: string;
      connects: ConnectParams[];
      presence: unknown[];
      assetHash: string;
      sourceBuildMetadata: string;
      pendingCount: number;
    }[] = [];
    await suite.runScenario(context, {
      retainedState: () => state.root,
      async run() {
        await state.writeConfig({
          gateway: {
            auth: { mode: "token", token },
            controlUi: { allowedOrigins: [new URL(suite.server.baseUrl).origin], enabled: false },
            port,
          },
        });
        state.applyEnv();
        const orphan = loadOrCreateDeviceIdentity({
          path: path.join(state.stateDir, "legacy-device.sqlite"),
        });
        const orphanRequest = await requestDevicePairing({
          deviceId: orphan.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(orphan.publicKeyPem),
          role: "operator",
          scopes: ["operator.read"],
          clientId: "legacy-platform-fixture",
          clientMode: "cli",
          platform: "MacIntel",
          displayName: "Disconnected legacy browser",
        });
        await approveDevicePairing(orphanRequest.request.requestId, {
          callerScopes: ["operator.admin"],
        });
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        for (const item of cases) {
          await suite.withPage(
            { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
            async ({ page }) => {
              await page.addInitScript(({ touch, ua }) => {
                Object.defineProperty(navigator, "platform", {
                  configurable: true,
                  get: () => "MacIntel",
                });
                Object.defineProperty(navigator, "maxTouchPoints", {
                  configurable: true,
                  get: () => touch,
                });
                Object.defineProperty(navigator, "userAgent", {
                  configurable: true,
                  get: () => ua,
                });
              }, item);
              const connects: ConnectParams[] = [];
              const presence: unknown[] = [];
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
                      const request = await requestDevicePairing({
                        deviceId,
                        publicKey: params.device.publicKey,
                        role: params.role,
                        scopes: params.scopes,
                        clientId: params.client.id,
                        clientMode: params.client.mode,
                        platform: params.client.platform,
                        displayName: item.name,
                      });
                      await approveDevicePairing(request.request.requestId, {
                        callerScopes: ["operator.admin"],
                      });
                      seeded = pairedFacts(
                        (await listDevicePairing()).paired.find((row) => row.deviceId === deviceId),
                      );
                    }
                  }
                  server.send(message);
                });
                server.onMessage((message) => {
                  const frame = JSON.parse(String(message));
                  if (frame.type === "res" && requestMethods.get(frame.id) === "connect") {
                    outcomes.push({ ok: frame.ok, error: frame.error });
                  }
                  if (frame.type === "res" && requestMethods.get(frame.id) === "system-presence") {
                    presence.push(frame.payload);
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
              await row.waitFor();
              await expect
                .poll(() => readText(row.locator(".device-entry__status")))
                .toBe("connected");
              await Promise.all(pendingApprovals);
              const paired = (await listDevicePairing()).paired.find(
                (entry) => entry.deviceId === deviceId,
              );
              const first = {
                paired: pairedFacts(paired),
                meta: await readText(row.locator(".device-entry__body > .settings-row__desc")),
                connect: connects[0],
                presence: [...presence],
              };
              await row.screenshot({
                path: path.join(suite.artifactDir, `${item.name}-before-reload.png`),
                animations: "disabled",
              });
              const script = expectDefined(
                await page.locator('script[type="module"][src]').first().getAttribute("src"),
                "production UI module",
              );
              const asset = await page.request.get(new URL(script, page.url()).href);
              expect(asset.ok()).toBe(true);
              const assetHash = createHash("sha256")
                .update(await asset.body())
                .digest("hex");
              const beforeCount = connects.length;
              await page.reload();
              await expect.poll(() => connects.length).toBeGreaterThan(beforeCount);
              await row.waitFor();
              await expect
                .poll(() => readText(row.locator(".device-entry__status")))
                .toBe("connected");
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
                expect(identityFacts(after)).toEqual(
                  seeded && {
                    deviceId: seeded.deviceId,
                    publicKey: seeded.publicKey,
                    approvedAtMs: seeded.approvedAtMs,
                    createdAtMs: seeded.createdAtMs,
                    roles: seeded.roles,
                    scopes: seeded.scopes,
                  },
                );
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
                expectedLabel: item.label,
                first,
                after: pairedFacts(after),
                meta,
                connects,
                presence,
                assetHash,
                sourceBuildMetadata: "synthetic; use source revision and asset hash",
                pendingCount: afterList.pending.length,
              });
              await writeFile(
                path.join(suite.artifactDir, "observations.json"),
                JSON.stringify(observations, null, 2),
              );
              if (item === cases.at(-1)) {
                await orphanRow.locator(".device-entry__menu-trigger").click();
                await orphanRow.locator('wa-dropdown-item[value="remove"]').click();
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
                await writeFile(
                  path.join(suite.artifactDir, "removal.json"),
                  JSON.stringify(
                    { removed: orphan.deviceId, remaining: remaining.map(pairedFacts) },
                    null,
                    2,
                  ),
                );
                const current = expectDefined(after, "current paired browser");
                const pinRequest = await requestDevicePairing({
                  deviceId,
                  publicKey: current.publicKey,
                  role: "operator",
                  scopes: current.scopes,
                  clientId: "openclaw-control-ui",
                  clientMode: "webchat",
                  platform: "MacIntel",
                  deviceFamily: "Mac",
                });
                await approveDevicePairing(pinRequest.request.requestId, {
                  callerScopes: ["operator.admin"],
                });
                const pinned = (await listDevicePairing()).paired.find(
                  (entry) => entry.deviceId === deviceId,
                );
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
                expect(request.silent).toBe(false);
                expect(request.deviceFamily).toBe("iPad");
                expect(identityFacts(retained)).toEqual(identityFacts(pinned));
                expect(retained?.deviceFamily).toBe("Mac");
                expect(outcomes.slice(outcomeStart).every((result) => !result.ok)).toBe(true);
                await writeFile(
                  path.join(suite.artifactDir, "metadata-upgrade-rejection.json"),
                  JSON.stringify(
                    {
                      pinned: pairedFacts(pinned),
                      retained: pairedFacts(retained),
                      pending: { silent: request.silent, deviceFamily: request.deviceFamily },
                      outcomes: outcomes.slice(outcomeStart),
                    },
                    null,
                    2,
                  ),
                );
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
        await gateway?.close({ reason: "platform family proof cleanup" });
      },
      release: async () => {
        await state.cleanup();
      },
    });
  }, 120_000);
});
