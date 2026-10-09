import "../test-utils/prepare-compiled-subprocesses.js";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { modelsRefreshCommand } from "../commands/models/refresh.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  createSecretsHandlers,
  createSecretStoreWriteService,
} from "../gateway/server-methods/secrets.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { acquireGatewayLock, type GatewayLockIdentity } from "../infra/gateway-lock.js";
import { captureGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { readRemoteModelCatalog } from "../model-catalog/remote-store.js";
import { listSecretStoreEntries, readSecretStoreValue } from "../secrets/store/secret-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerSecretStoreCli } from "./secrets-store-cli.js";

const fixture = vi.hoisted(() => ({
  remote: undefined as GatewayLockIdentity | undefined,
  client: false,
  transport: vi.fn(),
  fetch: vi.fn(),
  logs: [] as string[],
}));

vi.mock("../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-lock.js")>()),
  readActiveGatewayLockIdentity: async () => fixture.remote,
}));
vi.mock("../infra/gateway-state-owner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-state-owner.js")>();
  return {
    ...actual,
    // The in-process transport fixture presents the held Gateway as foreign to the CLI.
    captureGatewayStateOwner: (databasePath: string) =>
      fixture.client ? undefined : actual.captureGatewayStateOwner(databasePath),
  };
});
// mock-isolation: Use a direct authenticated transport; real routing, handlers, and stores stay composed.
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => fixture.transport(...args),
  isGatewayClientRequestError: () => false,
}));
vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/fetch-guard.js")>()),
  fetchWithSsrFGuard: (...args: unknown[]) => fixture.fetch(...args),
}));
// mock-isolation: Keep command output in the fixture and turn exits into observable failures.
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (message: string) => fixture.logs.push(message),
    error: (message: string) => fixture.logs.push(message),
    writeStdout: (message: string) => fixture.logs.push(message),
    writeJson: (value: unknown) => fixture.logs.push(JSON.stringify(value)),
    exit: (code: number) => {
      throw new Error(`exit:${code}`);
    },
  },
  writeRuntimeJson: (runtime: { writeJson: (value: unknown) => void }, value: unknown) =>
    runtime.writeJson(value),
}));
// mock-isolation: Tests observe the exit instead of scheduling process shutdown.
vi.mock("./one-shot-exit.js", () => ({
  exitCliAfterOutput: (runtime: { exit: (code: number) => never }, code: number) =>
    runtime.exit(code),
}));

async function command(...args: string[]) {
  const program = new Command().exitOverride();
  registerSecretStoreCli(program);
  fixture.client = true;
  try {
    await program.parseAsync(["store", ...args], { from: "user" });
  } finally {
    fixture.client = false;
  }
}

afterEach(() => {
  fixture.remote = undefined;
  fixture.client = false;
  fixture.logs.length = 0;
  fixture.transport.mockReset();
  fixture.fetch.mockReset();
});

it.each([false, true])(
  "keeps secret mutations with the state owner (Gateway running: %s)",
  async (online) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const lock = online
        ? await acquireGatewayLock({ role: "gateway", allowInTests: true, port: 18789 })
        : undefined;
      const reloadSecrets = vi.fn(async () => ({ warningCount: 0 }));
      const handlers = createSecretsHandlers({
        reloadSecrets,
        storeWriteService: createSecretStoreWriteService({ reloadSecrets }),
        resolveSecrets: async () => ({ assignments: [], diagnostics: [], inactiveRefPaths: [] }),
      });
      if (online) {
        const owner = captureGatewayStateOwner(state.statePath("state", "openclaw.sqlite"));
        expect(owner).toBeDefined();
        fixture.remote = {
          pid: process.pid,
          ownerId: owner!.ownerId,
          createdAt: "fixture",
          port: 18789,
        };
      }
      fixture.transport.mockImplementation(async (request) => {
        await request.prepareDispatchCurrent();
        request.assertDispatchCurrent();
        fixture.client = false;
        let response: Parameters<RespondFn> | undefined;
        try {
          await handlers[request.method]!({
            req: { type: "req", id: "owner-test", method: request.method },
            params: request.params,
            client: null,
            isWebchatConnect: () => false,
            context: { getRuntimeConfig } as GatewayRequestContext,
            respond: (...args) => {
              response = args;
            },
          });
          if (!response?.[0]) throw new Error(response?.[2]?.message ?? "missing response");
          return response[1];
        } finally {
          fixture.client = true;
        }
      });
      try {
        const secretFile = await state.writeText("synthetic-value", "synthetic-credential");
        await command("set", "CUSTOM_VALUE", "--kind", "secret", "--value-file", secretFile);
        expect(
          await readSecretStoreValue({ scope: { kind: "team" }, name: "CUSTOM_VALUE" }),
        ).toMatchObject({ ok: true, value: "synthetic-credential" });
        await command("set", "CUSTOM_VALUE", "--allow-host", "API.EXAMPLE.COM");
        expect((await listSecretStoreEntries({ scope: { kind: "team" } }))[0]).toMatchObject({
          kind: "secret",
          allowedHosts: ["api.example.com"],
        });
        const importFile = await state.writeText(
          "synthetic.env",
          "CUSTOM_VALUE=synthetic-rotated\nSERVICE_MODE=test\n",
        );
        await command("import", "--from", importFile, "--yes");
        expect(
          await readSecretStoreValue({ scope: { kind: "team" }, name: "CUSTOM_VALUE" }),
        ).toMatchObject({ ok: true, value: "synthetic-rotated" });
        expect(
          (await listSecretStoreEntries({ scope: { kind: "team" } })).find(
            (entry) => entry.name === "CUSTOM_VALUE",
          ),
        ).toMatchObject({ kind: "secret", allowedHosts: ["api.example.com"] });
        await command("rm", "CUSTOM_VALUE", "--yes");
        expect(
          (await readSecretStoreValue({ scope: { kind: "team" }, name: "CUSTOM_VALUE" })).ok,
        ).toBe(false);
        expect(fixture.transport.mock.calls.map(([request]) => request.method)).toEqual(
          online
            ? [
                "secrets.store.set",
                "secrets.store.allowedHosts",
                "secrets.store.import",
                "secrets.store.delete",
              ]
            : [],
        );
      } finally {
        fixture.remote = undefined;
        await lock?.release();
      }
    });
  },
);

it("refuses catalog refresh with a live owner, then downloads and persists offline", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };
    fixture.remote = {
      pid: process.pid,
      ownerId: "serving-owner",
      createdAt: "fixture",
      port: 18789,
    };
    await expect(modelsRefreshCommand({}, runtime)).rejects.toThrow("stop the Gateway");
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(readRemoteModelCatalog()).toBeUndefined();
    fixture.remote = undefined;
    const bundle = {
      schemaVersion: 2,
      generatedAt: 1_753_500_000_000,
      sourceCommit: "fixture",
      providers: { synthetic: {} },
      models: [{ id: "synthetic-model", provider: "synthetic", pricing: { status: "unknown" } }],
    };
    fixture.fetch.mockResolvedValue({
      response: new Response(JSON.stringify(bundle)),
      release: async () => {},
    });
    await modelsRefreshCommand({}, runtime);
    expect(readRemoteModelCatalog()?.generated_at).toBe(bundle.generatedAt);
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });
});
