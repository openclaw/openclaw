import { existsSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { Page } from "playwright";
import { expect, it, onTestFinished } from "vitest";
import type { SessionsCreateResult } from "../../../packages/gateway-protocol/src/schema/sessions.ts";
import type { SessionsListResult } from "../../../src/gateway/session-utils.types.js";
import { resolveOpenClawStateSqlitePath } from "../../../src/state/openclaw-state-db.paths.ts";
import { ensureCanonicalGatewayOwnerProfile } from "../../../src/state/user-profile-writes.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const artifacts = createControlUiE2eArtifactDir("personal-enrollment-real-gateway");
// The operator supplies an integrity-checked published install and candidate artifact.
// No download or package-policy exception is implicit in the ordinary E2E run.
const upgradeRoot = process.env.OPENCLAW_PERSONAL_UPGRADE_ROOT?.trim();
const inferencePortInput = process.env.OPENCLAW_PERSONAL_INFERENCE_PORT?.trim();
const inferencePort = inferencePortInput ? Number(inferencePortInput) : undefined;
if (
  inferencePortInput &&
  (!Number.isSafeInteger(inferencePort) ||
    !inferencePort ||
    inferencePort > 65535 ||
    inferencePort < 1)
) {
  throw new Error("Personal inference proof requires a valid owned loopback port.");
}
if (upgradeRoot && inferencePort) {
  throw new Error("Published upgrade and real-model proof use independent fixtures.");
}
const installedRoot = upgradeRoot
  ? path.resolve(upgradeRoot, "npm-prefix/lib/node_modules/openclaw")
  : undefined;
const entrypoint: [string] = [
  installedRoot ? path.join(installedRoot, "openclaw.mjs") : "dist/index.js",
];
let published:
  | {
      sessionKey: string;
      creatorProfileId: string;
      baselinePid: number | undefined;
    }
  | undefined;
let instance: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: upgradeRoot
    ? "Personal enrollment after the published 2026.11.3 upgrade"
    : "Personal enrollment through the packaged Gateway",
  startServerBeforeBrowser: true,
  setupTimeoutMs: 180_000,
  async startServer() {
    instance = await createOpenClawTestInstance({
      name: "personal-enrollment",
      entrypoint,
      env: {
        VITEST: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        ...(upgradeRoot
          ? {
              npm_config_prefix: path.resolve(upgradeRoot, "npm-prefix"),
              npm_config_userconfig: path.resolve(upgradeRoot, "npmrc"),
            }
          : {}),
      },
      config: {
        gateway: {
          controlUi: {
            enabled: true,
            root: installedRoot
              ? path.join(installedRoot, "dist/control-ui")
              : path.resolve("dist/control-ui"),
          },
        },
        ...(installedRoot
          ? {}
          : {
              agents: {
                entries: { main: { name: "Enrollment fixture" } },
                ...(inferencePort
                  ? {
                      defaults: {
                        model: { primary: "identity-local/identity-proof-qwen", fallbacks: [] },
                        modelPolicy: { allow: ["identity-local/*"] },
                        thinkingDefault: "off",
                      },
                    }
                  : {}),
              },
            }),
        ...(inferencePort
          ? {
              tools: { deny: ["*"] },
              models: {
                catalogRefresh: { enabled: false },
                providers: {
                  "identity-local": {
                    api: "openai-completions",
                    baseUrl: "http://127.0.0.1:" + inferencePort + "/v1",
                    apiKey: "local-proof",
                    models: [
                      {
                        id: "identity-proof-qwen",
                        name: "Qwen3.5 4B (local identity proof)",
                        reasoning: true,
                        input: ["text"],
                        contextWindow: 32768,
                        maxTokens: 1024,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        compat: { supportsTools: false, toolSchemaProfile: "llamacpp" },
                      },
                    ],
                  },
                },
              },
            }
          : {}),
        cron: { enabled: false },
        browser: { enabled: false },
        discovery: { mdns: { mode: "off" } },
        update: { checkOnStart: false },
        plugins: { allow: [] },
      },
    });
    try {
      if (installedRoot) {
        expect(
          JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")),
        ).toMatchObject({
          name: "openclaw",
          version: "2026.11.3",
          openclaw: { schemaVersions: { state: 22 } },
        });
        // Released code, not a current-store fixture helper, must create the baseline.
        expect(existsSync(resolveOpenClawStateSqlitePath(instance.env))).toBe(false);
        instance.env.XDG_CONFIG_HOME = path.join(instance.homeDir, ".config");
        instance.env.XDG_DATA_HOME = path.join(instance.homeDir, ".local/share");
        instance.env.XDG_STATE_HOME = path.join(instance.homeDir, ".local/state");
      } else {
        await ensureCanonicalGatewayOwnerProfile("Shared maintenance", { env: instance.env });
      }
      await instance.startGateway();
      return {
        baseUrl: "http://127.0.0.1:" + instance.port + "/",
        close: () => instance.cleanup(),
      };
    } catch (error) {
      await instance.cleanup();
      throw error;
    }
  },
});

async function rpc<T>(
  page: Page,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return evaluateControlUiContext(
    page,
    (app, input) => {
      const client = app.gateway.snapshot.client;
      if (!client) {
        throw new Error("Gateway is disconnected");
      }
      return client.request<T>(input.method, input.params);
    },
    { method, params },
  );
}

async function capture(page: Page, label: string) {
  const surface = page.locator("openclaw-profile-page .identity-name-control");
  const identity = surface.locator("input");
  await identity.waitFor({ state: "visible" });
  await surface.scrollIntoViewIfNeeded();
  const png = await takeControlUiViewportScreenshot(page, surface, [identity]);
  await writeFile(path.join(artifacts, label + ".png"), png);
}

function schemaVersion() {
  using database = new DatabaseSync(resolveOpenClawStateSqlitePath(instance.env), {
    readOnly: true,
  });
  return database.prepare("PRAGMA user_version").get()?.user_version;
}

async function upgradePublishedFixture(page: Page) {
  if (!upgradeRoot || !installedRoot) {
    return;
  }
  const before = await evaluateControlUiContext(page, (app) => ({
    profileId: app.gateway.snapshot.selfUser?.id,
    token: app.gateway.snapshot.hello?.auth?.deviceToken,
  }));
  expect(before.profileId).toBe("gateway-owner");
  expect(Boolean(before.token)).toBe(true);
  const legacy = await rpc<SessionsCreateResult>(page, "sessions.create", {
    agentId: "main",
    key: "agent:main:before-personal-upgrade",
    label: "Existing shared work",
  });
  if (!legacy.entry) {
    throw new Error("The released Gateway returned no session record to preserve.");
  }
  const creatorProfileId = "gateway-owner";
  expect(legacy.entry.createdActor).toEqual({
    type: "human",
    source: "profile",
    id: creatorProfileId,
  });
  expect(await rpc(page, "users.prefs.set", { entries: { "ui.themeMode": "light" } })).toEqual({
    status: "ok",
  });
  const baselinePid = instance.child?.pid;
  await instance.stopGateway();
  expect(schemaVersion()).toBe(22);
  // Keep an independent released runtime for the unsafe-older-reader check.
  await cp(installedRoot, path.join(upgradeRoot, "released-runtime"), {
    recursive: true,
    verbatimSymlinks: true,
    force: false,
    errorOnExist: true,
  });
  const update = await instance.cli(
    [
      "update",
      "--tag",
      path.resolve(upgradeRoot, "candidate.tgz"),
      "--yes",
      "--no-restart",
      "--json",
    ],
    { timeoutMs: 300_000 },
  );
  expect(update.code, update.stderr).toBe(0);
  expect(
    JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")),
  ).toMatchObject({ openclaw: { schemaVersions: { state: 40 } } });
  await instance.startGateway();
  expect(instance.child?.pid).not.toBe(baselinePid);
  await page.reload();
  await waitForControlUiGatewayReady(page);
  expect(schemaVersion()).toBe(40);
  const after = await evaluateControlUiContext(page, (app) => ({
    profileId: app.gateway.snapshot.selfUser?.id,
    method: app.gateway.snapshot.hello?.auth?.method,
    token: app.gateway.snapshot.hello?.auth?.deviceToken,
  }));
  expect(after.profileId).toBe(before.profileId);
  expect(after.method).toBe("device-token");
  // Failure output must not print either device credential.
  expect(after.token === before.token, "The released operator credential must survive").toBe(true);
  expect(await rpc(page, "users.prefs.get", { keys: ["ui.themeMode"] })).toEqual({
    status: "ok",
    entries: { "ui.themeMode": "light" },
  });
  const sessions = await rpc<SessionsListResult>(page, "sessions.list");
  const retained = sessions.sessions.find((row) => row.key === legacy.key);
  expect(retained?.label).toBe("Existing shared work");
  // Stored provenance uses source; list projections add identity and display-only avatars.
  expect(retained?.createdActor).toMatchObject({
    type: "human",
    id: creatorProfileId,
    identity: { type: "profile", id: creatorProfileId },
  });
  published = { sessionKey: legacy.key, creatorProfileId, baselinePid };
  await writeFile(
    path.join(artifacts, "published-upgrade-preservation.json"),
    JSON.stringify(
      {
        status: "preservation-passed",
        baselineVersion: "2026.11.3",
        baselineSchema: 22,
        candidateSchema: 40,
        baselinePid,
        candidatePid: instance.child?.pid,
        operatorCredentialPreserved: true,
        sharedPreferencesPreserved: true,
        sessionKey: legacy.key,
        creatorProfileId,
      },
      null,
      2,
    ) + "\n",
  );
}

async function inferAsEnrolledPerson(
  page: Page,
  sessionKey: string,
  sessionPath: string,
  personId: string,
) {
  if (!inferencePort) {
    return;
  }
  await page.goto(new URL(sessionPath, suite.server.baseUrl).href);
  await waitForControlUiGatewayReady(page);
  const controls = chatControls(page);
  await controls.composer.fill("Write one brief plain-text greeting. Do not use tools.");
  await controls.send.click();
  let reply: Record<string, unknown> | undefined;
  await expect
    .poll(
      async () => {
        const history = await rpc<{ messages: unknown[] }>(page, "chat.history", {
          sessionKey,
          limit: 20,
        });
        reply = history.messages
          .map(asOptionalRecord)
          .find(
            (message) =>
              message?.role === "assistant" &&
              message.provider === "identity-local" &&
              message.model === "identity-proof-qwen" &&
              (message.stopReason === "stop" || message.stopReason === "length"),
          );
        return Boolean(reply);
      },
      { timeout: 300_000, interval: 1000 },
    )
    .toBe(true);
  if (!reply || !Array.isArray(reply.content)) {
    throw new Error("No completed, model-generated personal reply was persisted.");
  }
  const response = reply.content
    .flatMap((part) => {
      const value = asOptionalRecord(part);
      return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n")
    .trim();
  expect(response.length).toBeGreaterThan(0);
  await expect
    .poll(async () =>
      (
        (await controls.pane.locator(".chat-group.assistant .chat-text").last().textContent()) ?? ""
      ).includes(response),
    )
    .toBe(true);
  expect(await evaluateControlUiContext(page, (app) => app.gateway.snapshot.selfUser?.id)).toBe(
    personId,
  );
  const sessions = await rpc<SessionsListResult>(page, "sessions.list");
  expect(sessions.sessions.find((row) => row.key === sessionKey)?.createdActor).toMatchObject({
    type: "human",
    id: personId,
    identity: { type: "profile", id: personId },
  });
  const metadata = asOptionalRecord(reply["__openclaw"]);
  await writeFile(
    path.join(artifacts, "real-model-proof.json"),
    JSON.stringify(
      {
        status: "passed",
        profileId: personId,
        sessionKey,
        provider: reply.provider,
        model: reply.model,
        stopReason: reply.stopReason,
        runId: metadata?.runId,
        responseCharacters: response.length,
        usage: reply.usage,
        transport: "real loopback llama.cpp; pinned weights and process receipt kept separately",
      },
      null,
      2,
    ) + "\n",
  );
  await page.goto(suite.server.baseUrl + "settings/profile");
  await waitForControlUiGatewayReady(page);
}

suite.define(() => {
  it(
    "enrolls from Profile, owns a session, survives rotation and a cold restart, then revokes HTTP without owner fallback",
    async ({ signal }) => {
      onTestFinished(async () => {
        const logs = instance
          .logs()
          .replaceAll(instance.gatewayToken, "[fixture-auth]")
          .replaceAll(instance.hookToken, "[fixture-hook]");
        await writeFile(path.join(artifacts, "gateway.log"), logs);
      });
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" },
        async ({ page }) => {
          await pairFixture(page, instance);
          await upgradePublishedFixture(page);
          await page.goto(suite.server.baseUrl + "settings/profile");
          await waitForControlUiGatewayReady(page);
          await assertServedUi(
            page,
            suite.server.baseUrl,
            installedRoot ? path.join(installedRoot, "dist/control-ui") : undefined,
          );
          await page
            .locator(".personal-enrollment")
            .getByRole("button", { name: "Set up personal profile" })
            .waitFor();
          await capture(page, "shared-owner");
          const surface = page.locator(".personal-enrollment");
          await surface.getByRole("button", { name: "Set up personal profile" }).click();
          const name = surface.getByRole("textbox", { name: "Your name (optional)" });
          await name.fill("Ada Fixture");
          expect(await name.inputValue()).toBe("Ada Fixture");
          await capture(page, "personal-form-desktop");
          await surface.getByRole("button", { name: "Use this profile", exact: true }).click();
          await expect
            .poll(() =>
              evaluateControlUiContext(page, (app) => app.gateway.snapshot.selfUser?.name),
            )
            .toBe("Ada Fixture");
          const personId = await evaluateControlUiContext(
            page,
            (app) => app.gateway.snapshot.selfUser?.id,
          );
          if (!personId) {
            throw new Error("Personal profile was not admitted");
          }
          expect(personId).not.toBe("gateway-owner");
          // First-run owner handoffs start without named roles. Once enrolled, the same
          // device must reconnect under a newly configured personal restriction.
          const narrowed = await instance.cli([
            "config",
            "set",
            "gateway.roles",
            JSON.stringify({
              default: "writer",
              definitions: {
                writer: {
                  scopes: ["operator.read", "operator.write"],
                  agents: "*",
                  sessions: { others: "none" },
                },
              },
            }),
            "--strict-json",
          ]);
          expect(narrowed.code, narrowed.stderr).toBe(0);
          await expect
            .poll(() =>
              evaluateControlUiContext(page, (app) => app.gateway.snapshot.hello?.auth?.scopes),
            )
            .toEqual(["operator.read", "operator.write"]);
          const auth = await evaluateControlUiContext(page, (app) => ({
            deviceId: app.gateway.snapshot.client?.profileEnrollment.deviceId,
            scopes: app.gateway.snapshot.hello?.auth?.scopes,
            token: app.gateway.snapshot.hello?.auth?.deviceToken,
          }));
          if (!auth.deviceId || !auth.token) {
            throw new Error("Personal reconnect did not return its device credential");
          }
          expect(auth.scopes).toEqual(["operator.read", "operator.write"]);
          const session = await rpc<SessionsCreateResult>(page, "sessions.create", {
            agentId: "main",
            key: "agent:main:personal-enrollment-proof",
            label: "Personal planning",
          });
          expect(session.entry).toMatchObject({
            createdActor: { type: "human", source: "profile", id: personId },
          });
          const sessionPath = buildControlUiSessionPath({
            namespace: "chat",
            sessionKey: session.key,
            exactKey: true,
          });
          if (!sessionPath) {
            throw new Error("The created session has no canonical Control UI path");
          }
          const entryQuery = new URLSearchParams({ path: sessionPath, probe: "1" });
          const readEntry = (token: string) =>
            fetch(suite.server.baseUrl + "__openclaw__/session-entry?" + entryQuery.toString(), {
              headers: { authorization: "Bearer " + token },
            });
          const readable = await readEntry(auth.token);
          expect(readable.status).toBe(204);
          await readable.arrayBuffer();
          const profileRead = await fetch(suite.server.baseUrl + "control-ui-config.json", {
            headers: { authorization: "Bearer " + auth.token },
          });
          expect(profileRead.status).toBe(200);
          expect(await profileRead.json()).toMatchObject({ preferences: { profileId: personId } });
          // Raw session-history API deliberately remains shared-secret-only. Enrollment
          // must not expand that separate HTTP credential contract.
          const rawHistory = await fetch(
            suite.server.baseUrl + "sessions/" + encodeURIComponent(session.key) + "/history",
            { headers: { authorization: "Bearer " + auth.token } },
          );
          expect(rawHistory.status).toBe(401);
          await rawHistory.arrayBuffer();
          await inferAsEnrolledPerson(page, session.key, sessionPath, personId);
          await expect(
            rpc(page, "device.token.rotate", { deviceId: auth.deviceId, role: "operator" }),
          ).rejects.toThrow();
          await capture(page, "personal-desktop");
          await page.setViewportSize({ width: 390, height: 844 });
          await capture(page, "personal-mobile");
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);

          const secondContext = await suite.newBrowserContext({
            viewport: { width: 820, height: 900 },
          });
          try {
            const second = await secondContext.newPage();
            await second.goto(suite.server.baseUrl);
            await second
              .getByRole("button", { name: "Pair with a code instead", exact: true })
              .click();
            await second.getByRole("button", { name: "Get a code", exact: true }).click();
            await expect
              .poll(() => second.locator(".login-gate__command").textContent())
              .toContain("openclaw pair");
            const code = (await second.locator(".login-gate__command").textContent())?.match(
              /openclaw pair ([A-Z0-9-]+)/,
            )?.[1];
            if (!code) {
              throw new Error("The second browser received no pairing code");
            }
            const approved = await instance.cli(["pair", code, "--person", personId, "--yes"]);
            expect(approved.code, approved.stderr).toBe(0);
            await waitForControlUiGatewayReady(second);
            expect(
              await evaluateControlUiContext(second, (app) => app.gateway.snapshot.selfUser?.id),
            ).toBe(personId);
          } finally {
            await suite.closeBrowserContext(secondContext);
          }

          const enrolledCli = await instance.cli([
            "devices",
            "enroll",
            "--person",
            personId,
            "--json",
          ]);
          expect(enrolledCli.code, enrolledCli.stderr).toBe(0);
          expect(JSON.parse(enrolledCli.stdout)).toMatchObject({ profileId: personId });
          for (const [flags, expectedPerson] of [
            [[], "gateway-owner"],
            [["--device-auth"], personId],
          ] as const) {
            const self = await instance.cli(["gateway", "call", "users.self", "--json", ...flags]);
            expect(self.code, self.stderr).toBe(0);
            expect(JSON.parse(self.stdout)).toMatchObject({ profile: { id: expectedPerson } });
          }

          const firstPid = instance.child?.pid;
          await instance.stopGateway();
          await instance.startGateway();
          expect(instance.child?.pid).not.toBe(firstPid);
          await page.reload();
          await waitForControlUiGatewayReady(page);
          expect(
            await evaluateControlUiContext(page, (app) => app.gateway.snapshot.selfUser?.id),
          ).toBe(personId);
          const admin = await connectChatGateway(instance, signal);
          try {
            await admin.request("device.token.rotate", {
              deviceId: auth.deviceId,
              role: "operator",
            });
            const obsolete = await readEntry(auth.token);
            expect(obsolete.status).toBe(401);
            await obsolete.arrayBuffer();
            await pairFixture(page, instance);
            expect(
              await evaluateControlUiContext(page, (app) => app.gateway.snapshot.selfUser?.id),
            ).toBe(personId);
            const current = await evaluateControlUiContext(
              page,
              (app) => app.gateway.snapshot.hello?.auth?.deviceToken,
            );
            if (!current) {
              throw new Error("Recovered installation has no operator token");
            }
            await admin.request("device.token.revoke", {
              deviceId: auth.deviceId,
              role: "operator",
            });
            const revoked = await readEntry(current);
            expect(revoked.status).toBe(401);
            await revoked.arrayBuffer();
            expect(
              (await admin.request<{ profile: { id: string } }>("users.self", {})).profile.id,
            ).toBe("gateway-owner");
            if (published) {
              const shared = await admin.request<SessionsListResult>("sessions.list", {});
              const retained = shared.sessions.find((row) => row.key === published?.sessionKey);
              expect(retained?.label).toBe("Existing shared work");
              expect(retained?.createdActor).toMatchObject({
                type: "human",
                id: published.creatorProfileId,
                identity: { type: "profile", id: published.creatorProfileId },
              });
              expect(await admin.request("users.prefs.get", { keys: ["ui.themeMode"] })).toEqual({
                status: "ok",
                entries: { "ui.themeMode": "light" },
              });
            }
          } finally {
            await admin.stopAndWait();
          }
          if (published && upgradeRoot) {
            await instance.stopGateway();
            const current = entrypoint[0];
            entrypoint[0] = path.resolve(upgradeRoot, "released-runtime/openclaw.mjs");
            const stdoutOffset = instance.stdout.join("").length;
            const stderrOffset = instance.stderr.join("").length;
            try {
              await expect(instance.startGateway()).rejects.toThrow();
              // Earlier candidate migration logs cannot satisfy the older-reader oracle.
              const refusal =
                instance.stdout.join("").slice(stdoutOffset) +
                instance.stderr.join("").slice(stderrOffset);
              expect(refusal).toMatch(
                /schema.*(?:newer|40|supported)|(?:newer|incompatible|unsupported).*schema/is,
              );
            } finally {
              entrypoint[0] = current;
            }
            using database = new DatabaseSync(resolveOpenClawStateSqlitePath(instance.env), {
              readOnly: true,
            });
            expect(
              database
                .prepare(
                  "SELECT operator_profile_id FROM device_pairing_paired WHERE device_id = ?",
                )
                .get(auth.deviceId),
            ).toEqual({ operator_profile_id: personId });
          }
          await writeFile(
            path.join(artifacts, "result.json"),
            JSON.stringify(
              {
                personId,
                deviceId: auth.deviceId,
                sessionKey: session.key,
                firstPid,
                restartedPid: instance.child?.pid,
                status: "passed",
                ...(published
                  ? {
                      publishedUpgrade: {
                        baseline: "2026.11.3",
                        baselineSchema: 22,
                        candidateSchema: 40,
                        baselinePid: published.baselinePid,
                        sharedStatePreserved: true,
                        releasedReaderRefused: true,
                      },
                    }
                  : {}),
              },
              null,
              2,
            ),
          );
        },
      );
    },
    upgradeRoot || inferencePort ? 600_000 : 180_000,
  );
});
