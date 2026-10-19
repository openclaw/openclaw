import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

const storeMocks = vi.hoisted(() => ({
  deleteEntry: vi.fn(),
  listEntries: vi.fn(() => [] as Array<Record<string, unknown>>),
  purgeEntries: vi.fn(async () => 0),
  writeEntry: vi.fn(),
  getSnapshot: vi.fn(() => ({ sourceConfig: {} })),
  collectRefKeys: vi.fn((_config: unknown, _name: string) => new Set<string>()),
}));

vi.mock("../../secrets/runtime-source-contract.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../secrets/runtime-source-contract.js")>()),
  collectSecretStoreRefKeysInSnapshot: storeMocks.collectRefKeys,
}));

vi.mock("../../secrets/runtime-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../secrets/runtime-state.js")>()),
  getActiveSecretsRuntimeSnapshotState: storeMocks.getSnapshot,
}));

// mock-isolation: Observe mutation dispatch without opening the real secret database.
vi.mock("../../secrets/store/secret-store.js", () => {
  class SecretStoreValidationError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "SecretStoreValidationError";
    }
  }
  return {
    deleteSecretStoreEntry: storeMocks.deleteEntry,
    listSecretStoreEntries: storeMocks.listEntries,
    purgeExpiredSecretStoreEntries: storeMocks.purgeEntries,
    SecretStoreValidationError,
    writeSecretStoreEntry: storeMocks.writeEntry,
    writeSecretStoreEntries: vi.fn(),
    updateSecretStoreAllowedHosts: vi.fn(),
  };
});

// Handler tests only need the registry verdicts they exercise. Dedicated
// target-registry tests own bundled plugin discovery and compilation.
vi.mock("../../secrets/target-registry.js", () => ({
  isKnownCoreSecretTargetId: (value: unknown) => value === "talk.providers.*.apiKey",
  isKnownSecretTargetId: () => false,
}));

import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
} from "../../test-utils/talk-test-provider.js";
import { QuestionManager } from "../question-manager.js";
import { createSecretsHandlers, createSecretStoreWriteService } from "./secrets.js";
import type { GatewayClient, RespondFn } from "./types.js";

type Invocation = {
  handlers: ReturnType<typeof createSecretsHandlers>;
  respond: RespondFn;
};

async function invoke(
  { handlers, respond }: Invocation,
  method: string,
  params: Record<string, unknown> = {},
  client: GatewayClient | null = null,
) {
  await expectDefined(
    handlers[method],
    `handler ${method}`,
  )({
    req: { type: "req", id: "1", method },
    params,
    client,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  });
}

const storeClient = {
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "control-ui",
      version: "test",
      platform: "web",
      mode: "webchat",
      displayName: "Control UI",
    },
    role: "operator",
    scopes: ["operator.admin"],
  },
} as GatewayClient;

function expectRespondError(
  respond: ReturnType<typeof vi.fn>,
  expected: { code: string; message?: string },
): void {
  const [ok, result, error] = respond.mock.calls[0] ?? [];
  expect([ok, result]).toEqual([false, undefined]);
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    throw new Error("Expected a non-array error record");
  }
  expect(error).toMatchObject(expected);
}

function expectWarnMessageWith(warn: ReturnType<typeof vi.fn>, text: string): void {
  expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(text);
}

describe("secrets handlers", () => {
  it("keeps an answer pending until its store write acknowledges the commit", async () => {
    const persisted = createDeferred();
    storeMocks.writeEntry.mockReturnValueOnce(persisted.promise);
    const scheduler = createTestGatewayScheduler();
    const manager = new QuestionManager(scheduler);
    const service = createSecretStoreWriteService({
      reloadSecrets: async () => ({ warningCount: 0 }),
    });
    const record = manager.request({
      questions: [
        {
          questionId: "secret_value",
          question: "Save key",
          header: "Key",
          options: [],
          isSecret: true,
        },
      ],
      timeoutMs: 10_000,
    });
    const pending = manager.resolveWithCommit(
      record.id,
      { answers: { secret_value: ["stored"] } },
      undefined,
      {
        commit: async (assertCurrent) => {
          await service.write({
            name: "SYNTHETIC_KEY",
            value: "synthetic-value",
            kind: "secret",
            updatedBy: "test",
            assertCurrent,
          });
        },
      },
    );
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(manager.get(record.id)?.status).toBe("pending");
    } finally {
      persisted.resolve();
      await pending;
      manager.close();
      await manager.drain();
      await scheduler.stop();
    }
    await expect(pending).resolves.toMatchObject({ status: "answered" });
  });

  beforeEach(() => {
    storeMocks.deleteEntry.mockReset();
    storeMocks.listEntries.mockReset().mockReturnValue([]);
    storeMocks.purgeEntries.mockReset().mockResolvedValue(0);
    storeMocks.writeEntry.mockReset();
    storeMocks.getSnapshot.mockReset().mockReturnValue({ sourceConfig: {} });
    storeMocks.collectRefKeys.mockReset().mockReturnValue(new Set());
  });

  function createHandlers({
    reloadSecrets = async () => ({ warningCount: 0 }),
    resolveSecrets = async () => ({ assignments: [], diagnostics: [], inactiveRefPaths: [] }),
    log,
  }: Partial<Omit<Parameters<typeof createSecretsHandlers>[0], "storeWriteService">> = {}) {
    return createSecretsHandlers({
      reloadSecrets,
      storeWriteService: createSecretStoreWriteService({ reloadSecrets, log }),
      resolveSecrets,
      log,
    });
  }

  it("responds with warning count on successful reload", async () => {
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockResolvedValue({ warningCount: 2 }),
    });
    const respond = vi.fn();
    await invoke({ handlers, respond }, "secrets.reload");
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 2 });
  });

  it("returns unavailable when reload fails", async () => {
    const warn = vi.fn();
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockRejectedValue(new Error("disk full")),
      log: { warn },
    });
    const respond = vi.fn();
    await invoke({ handlers, respond }, "secrets.reload");
    expectRespondError(respond, {
      code: "UNAVAILABLE",
      message: "secrets.reload failed",
    });
    expectWarnMessageWith(warn, "disk full");
  });

  it("resolves requested command secret assignments from the active snapshot", async () => {
    const resolution = {
      assignments: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          value: "sk",
        },
      ],
      diagnostics: ["note"],
      inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    };
    const resolveSecrets = vi.fn().mockResolvedValue(structuredClone(resolution));
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invoke({ handlers, respond }, "secrets.resolve", {
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
      allowedPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
      forcedActivePaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    expect(resolveSecrets).toHaveBeenCalledWith({
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
      allowedPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
      forcedActivePaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, ...resolution });
  });

  it("rejects secrets.resolve params when targetIds entries are not strings", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invoke({ handlers, respond }, "secrets.resolve", {
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey", 12],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: "INVALID_REQUEST",
      message: "invalid secrets.resolve params: targetIds",
    });
  });

  it("rejects unknown secrets.resolve target ids", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invoke({ handlers, respond }, "secrets.resolve", {
      commandName: "memory status",
      targetIds: ["unknown.target"],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: "INVALID_REQUEST",
      message: 'invalid secrets.resolve params: unknown target id "unknown.target"',
    });
  });

  it("returns unavailable when secrets.resolve handler returns an invalid payload shape", async () => {
    const warn = vi.fn();
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [{ path: TALK_TEST_PROVIDER_API_KEY_PATH, pathSegments: [""], value: "sk" }],
      diagnostics: [],
      inactiveRefPaths: [],
    });
    const handlers = createHandlers({ resolveSecrets, log: { warn } });
    const respond = vi.fn();
    await invoke({ handlers, respond }, "secrets.resolve", {
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
    });
    expectRespondError(respond, { code: "UNAVAILABLE", message: "secrets.resolve failed" });
    expectWarnMessageWith(warn, "secrets.resolve returned invalid payload.");
  });

  it("lists env values without structurally disclosing secret values", async () => {
    const metadata = {
      scopeKind: "team",
      scopeId: "",
      createdAtMs: 1,
      updatedAtMs: 2,
      updatedBy: "Operator",
    };
    storeMocks.listEntries.mockReturnValueOnce([
      {
        ...metadata,
        name: "SERVICE_API_KEY",
        kind: "secret",
        allowedHosts: ["api.example.com"],
        valuePreview: "malicious-leak",
      },
      {
        ...metadata,
        name: "SERVICE_URL",
        kind: "env",
        valuePreview: "https://service.test",
      },
    ]);
    const respond = vi.fn();
    await invoke({ handlers: createHandlers(), respond }, "secrets.store.list", {}, storeClient);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      entries: [
        { name: "SERVICE_API_KEY", kind: "secret", allowedHosts: ["api.example.com"] },
        { name: "SERVICE_URL", kind: "env", value: "https://service.test" },
      ],
    });
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("malicious-leak");
  });

  it("refreshes the runtime only after mutations of referenced store names", async () => {
    storeMocks.collectRefKeys.mockImplementation((_config, name) =>
      name === "SERVICE_API_KEY" ? new Set(["store:default:SERVICE_API_KEY"]) : new Set(),
    );
    const reloadSecrets = vi.fn().mockResolvedValue({ warningCount: 2 });
    const warn = vi.fn();
    const handlers = createHandlers({ reloadSecrets, log: { warn } });
    const expiry = createDeferred<number>();
    const expiryStarted = createDeferred();
    storeMocks.purgeEntries.mockImplementationOnce(() => {
      expiryStarted.resolve();
      return expiry.promise;
    });

    storeMocks.writeEntry.mockResolvedValueOnce("secret");
    const setRespond = vi.fn();
    const mutation = invoke(
      { handlers, respond: setRespond },
      "secrets.store.set",
      {
        name: "SERVICE_API_KEY",
        value: "new-value",
        kind: "secret",
        allowedHosts: ["api.example.com"],
      },
      storeClient,
    );
    await expiryStarted.promise;
    expect(storeMocks.purgeEntries).toHaveBeenCalledOnce();
    expect(reloadSecrets).not.toHaveBeenCalled();
    expect(setRespond).not.toHaveBeenCalled();
    expiry.reject(new Error("synthetic expiry failure"));
    await mutation;
    expectWarnMessageWith(warn, "secrets.store retention purge failed: synthetic expiry failure");
    expect(storeMocks.writeEntry).toHaveBeenCalledWith({
      scope: { kind: "team" },
      name: "SERVICE_API_KEY",
      value: "new-value",
      kind: "secret",
      allowedHosts: ["api.example.com"],
      updatedBy: "Control UI",
      assertCurrent: expect.any(Function),
    });
    expect(setRespond).toHaveBeenCalledWith(true, {
      ok: true,
      reloaded: true,
      warningCount: 2,
    });

    const deleteRespond = vi.fn();
    await invoke(
      { handlers, respond: deleteRespond },
      "secrets.store.delete",
      { name: "SERVICE_URL" },
      storeClient,
    );
    expect(deleteRespond).toHaveBeenCalledWith(true, { ok: true, reloaded: false });
    expect(reloadSecrets).toHaveBeenCalledTimes(1);
    expect(reloadSecrets).toHaveBeenCalledWith({
      forceColdRefKeys: new Set(["store:default:SERVICE_API_KEY"]),
      joinInFlight: false,
    });
  });

  it("registers submitted store values for redaction before a failing write", async () => {
    const value = "test-secret-value-redaction-before-write-123";
    storeMocks.writeEntry.mockImplementationOnce(() => {
      expect(isSecretValueRegisteredForRedaction(value)).toBe(true);
      throw new Error("database unavailable");
    });
    const respond = vi.fn();

    await invoke(
      { handlers: createHandlers(), respond },
      "secrets.store.set",
      { name: "SERVICE_API_KEY", value, kind: "secret" },
      storeClient,
    );

    expectRespondError(respond, { code: "UNAVAILABLE", message: "secrets.store.set failed" });
    expect(isSecretValueRegisteredForRedaction(value)).toBe(true);
  });

  it("rejects invalid store params before writing", async () => {
    const respond = vi.fn();
    await invoke(
      { handlers: createHandlers(), respond },
      "secrets.store.set",
      { name: "lowercase", value: "value", kind: "secret" },
      storeClient,
    );
    expect(storeMocks.writeEntry).not.toHaveBeenCalled();
    expectRespondError(respond, { code: "INVALID_REQUEST" });
  });

  it("reports a saved entry when its required runtime refresh fails", async () => {
    storeMocks.collectRefKeys.mockReturnValue(new Set(["store:default:SERVICE_API_KEY"]));
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    });
    const respond = vi.fn();

    await invoke(
      { handlers, respond },
      "secrets.store.set",
      { name: "SERVICE_API_KEY", value: "new-value", kind: "secret" },
      storeClient,
    );

    expect(storeMocks.writeEntry).toHaveBeenCalledOnce();
    expectRespondError(respond, {
      code: "UNAVAILABLE",
      message:
        "Secret store entry was saved, but post-write runtime refresh failed. Resolve provider errors and retry secrets.reload.",
    });
  });
});
