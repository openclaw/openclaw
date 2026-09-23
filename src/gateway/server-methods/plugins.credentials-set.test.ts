import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigWritePostCommitError } from "../../config/io.write-errors.js";
import { createPluginCredentialSetHandlers } from "./plugins.credentials-set.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  write: vi.fn(),
  metadata: vi.fn(),
  stage: vi.fn(),
  rollback: vi.fn(),
  reload: vi.fn(),
}));
vi.mock("../../config/write-lock.js", () => ({
  withConfigWriteLock: async (_path: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.snapshot,
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: await mocks.snapshot(),
    writeOptions: {},
  }),
  replaceConfigFile: mocks.write,
  resolveConfigSnapshotHash: (snapshot: { hash: string }) => snapshot.hash,
  createConfigIO: () => ({ configPath: "/fixture/config" }),
}));
vi.mock("../../plugins/management-service.js", () => ({
  resolveManagedPluginMetadata: mocks.metadata,
}));
vi.mock("../../secrets/store/secret-store-worker.js", () => ({
  withSecretStoreStagedWrite: mocks.stage,
}));
const storeName = (path: readonly string[]) =>
  "PLUGIN_CREDENTIAL_" +
  createHash("sha256")
    .update(JSON.stringify(["example", path]))
    .digest("hex")
    .toUpperCase();
const path = ["plugins", "entries", "example", "config", "key"];
const ref = {
  source: "store",
  provider: "default",
  id: storeName(path),
};
const source = () => ({ plugins: { entries: { example: { config: { sibling: "preserved" } } } } });
const handlers = createPluginCredentialSetHandlers({
  reloadReference: mocks.reload,
  resolveUpdatedBy: () => "test",
});
function request() {
  return {
    params: {
      pluginId: "example",
      path,
      baseHash: "public:revision",
      value: "synthetic-replacement",
    },
    client: { connect: { scopes: ["operator.admin"] } },
    context: {
      getRuntimeConfig: () => source(),
      configRevisionProjector: { projectRawHash: (hash: string) => "public:" + hash },
    },
    respond: vi.fn(),
  } as unknown as GatewayRequestHandlerOptions;
}
async function invoke(options = request()) {
  await handlers["plugins.credentials.set"]!(options);
  return options.respond;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.snapshot.mockResolvedValue({
    valid: true,
    hash: "revision",
    path: "/fixture/config",
    sourceConfig: source(),
  });
  mocks.metadata.mockReturnValue({
    byPluginId: new Map([
      [
        "example",
        {
          id: "example",
          origin: "bundled",
          configContracts: {
            secretInputs: { paths: [{ path: "key", expected: "string", ownerKind: "capability" }] },
          },
        },
      ],
    ]),
  });
  mocks.stage.mockImplementation(async (_params, guard, run) => {
    guard();
    return run({ rollback: mocks.rollback });
  });
  mocks.rollback.mockResolvedValue(true);
  mocks.reload.mockResolvedValue({ reloaded: true });
  mocks.write.mockImplementation(async ({ sourceConfig, writeOptions }) => {
    writeOptions.assertCurrent();
    return { nextConfig: sourceConfig, persistedHash: "next" };
  });
});
describe("protected plugin credential set", () => {
  it("stages protected bytes before exact source CAS and writes only the declared ref", async () => {
    expect(await invoke()).toHaveBeenCalledWith(true, { saved: true }, undefined);
    expect(mocks.stage).toHaveBeenCalledWith(
      expect.objectContaining({ name: ref.id, value: "synthetic-replacement", kind: "secret" }),
      expect.any(Function),
      expect.any(Function),
    );
    const input = mocks.write.mock.calls[0]![0];
    expect(input.baseHash).toBe("revision");
    expect(input.sourceConfig.plugins.entries.example.config).toEqual({
      sibling: "preserved",
      key: ref,
    });
    expect(mocks.reload).toHaveBeenCalledWith(ref.id);
    expect(mocks.rollback).not.toHaveBeenCalled();
  });
  it("acknowledges a committed save when its own reload invalidates the client", async () => {
    const options = request();
    mocks.reload.mockImplementation(async () => {
      options.client!.invalidated = true;
      return { reloaded: true };
    });
    expect(await invoke(options)).toHaveBeenCalledWith(true, { saved: true }, undefined);
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.rollback).not.toHaveBeenCalled();
  });
  it.each(["readonly", "stale", "revoked", "undeclared", "disabled"])(
    "refuses %s before storing bytes",
    async (mode) => {
      const options = request();
      if (mode === "readonly") {
        options.client!.connect.scopes = ["operator.read"];
      }
      if (mode === "stale") {
        options.params = { ...(options.params as object), baseHash: "old" };
      }
      if (mode === "revoked") {
        mocks.snapshot.mockImplementation(async () => {
          options.client!.invalidated = true;
          return {};
        });
      }
      if (mode === "undeclared") {
        options.params = { ...(options.params as object), path: [...path, "other"] };
      }
      if (mode === "disabled") {
        options.context.getRuntimeConfig = () => ({ plugins: { enabled: false } });
      }
      expect(await invoke(options)).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      expect(mocks.stage).not.toHaveBeenCalled();
    },
  );
  it.each([
    { source: "env", provider: "default", id: "EXTERNAL" },
    { source: "store", provider: "default", id: "UNOWNED" },
  ])("preserves an external or unowned ref", async (key) => {
    mocks.snapshot.mockResolvedValue({
      valid: true,
      hash: "revision",
      sourceConfig: { plugins: { entries: { example: { config: { key } } } } },
    });
    await invoke();
    expect(mocks.stage).not.toHaveBeenCalled();
  });
  it.each(["prepare", "cas", "authority"])(
    "compensates a %s refusal and never reloads",
    async (mode) => {
      const options = request();
      mocks.write.mockImplementation(async ({ writeOptions }) => {
        if (mode === "authority") {
          options.client!.invalidated = true;
          writeOptions.assertCurrent();
        }
        throw new Error(mode);
      });
      await invoke(options);
      expect(mocks.rollback).toHaveBeenCalledOnce();
      expect(mocks.reload).not.toHaveBeenCalled();
    },
  );
  it.each(["unknown", "not-restored"] as const)(
    "retains bytes after %s publication unless original config is proven restored",
    async (rollbackStatus) => {
      mocks.write.mockRejectedValue(
        new ConfigWritePostCommitError({
          configPath: "/fixture/config",
          rollbackStatus,
          cause: new Error("private"),
        }),
      );
      mocks.snapshot
        .mockResolvedValueOnce({
          valid: true,
          hash: "revision",
          path: "/fixture/config",
          sourceConfig: source(),
        })
        .mockResolvedValueOnce({
          valid: true,
          hash: "revision",
          path: "/fixture/config",
          sourceConfig: source(),
        })
        .mockResolvedValue({
          valid: true,
          hash: "changed",
          path: "/fixture/config",
          sourceConfig: source(),
        });
      await invoke();
      expect(mocks.rollback).not.toHaveBeenCalled();
      expect(mocks.write).toHaveBeenCalledOnce();
    },
  );
  it("compensates an uncertain write only after exact original-source reconciliation", async () => {
    mocks.write.mockRejectedValue(
      new ConfigWritePostCommitError({
        configPath: "/fixture/config",
        rollbackStatus: "unknown",
        cause: new Error("private"),
      }),
    );
    await invoke();
    expect(mocks.rollback).toHaveBeenCalledOnce();
  });
  it("reports canonical cold-reload warnings without echoing secrets", async () => {
    mocks.reload.mockResolvedValue({ reloaded: true, warningCount: 1 });
    expect(await invoke()).toHaveBeenCalledWith(
      true,
      { saved: true, warning: expect.any(String) },
      undefined,
    );
  });
  it("rotates an owned stable ref and reports refresh failure without restoring stale bytes", async () => {
    mocks.snapshot.mockResolvedValue({
      valid: true,
      hash: "revision",
      path: "/fixture/config",
      sourceConfig: { plugins: { entries: { example: { config: { key: ref } } } } },
    });
    mocks.reload.mockRejectedValue(new Error("private"));
    expect(await invoke()).toHaveBeenCalledWith(
      true,
      { saved: true, warning: expect.any(String) },
      undefined,
    );
    expect(mocks.rollback).not.toHaveBeenCalled();
  });
});

it.each([false, true])(
  "uses configured store aliases without retargeting an existing owned reference: %s",
  async (existing) => {
    const key = { ...ref, provider: "original" };
    const config = {
      secrets: {
        defaults: { store: "vault" },
        providers: { vault: { source: "store" }, original: { source: "store" } },
      },
      plugins: {
        entries: { example: { config: { sibling: "preserved", ...(existing ? { key } : {}) } } },
      },
    };
    mocks.snapshot.mockResolvedValue({
      valid: true,
      hash: "revision",
      path: "/fixture/config",
      sourceConfig: config,
    });
    expect(await invoke()).toHaveBeenCalledWith(true, { saved: true }, undefined);
    const input = mocks.write.mock.calls[0]![0];
    expect(input.sourceConfig.plugins.entries.example.config.key.provider).toBe(
      existing ? "original" : "vault",
    );
  },
);

it("preserves array entries and unrelated credentials when authoring a concrete capability target", async () => {
  const target = ["plugins", "entries", "example", "config", "items", "0", "key"];
  const config = {
    plugins: {
      entries: {
        example: {
          config: { items: [{ label: "first" }, { label: "second", key: "synthetic-unrelated" }] },
        },
      },
    },
  };
  mocks.metadata.mockReturnValue({
    byPluginId: new Map([
      [
        "example",
        {
          id: "example",
          origin: "bundled",
          configContracts: {
            secretInputs: {
              paths: [{ path: "items.0.key", ownerKind: "capability", expected: "string" }],
            },
          },
        },
      ],
    ]),
  });
  mocks.snapshot.mockResolvedValue({
    valid: true,
    hash: "revision",
    path: "/fixture/config",
    sourceConfig: config,
  });
  const options = request();
  options.params = { ...(options.params as object), path: target };
  expect(await invoke(options)).toHaveBeenCalledWith(true, { saved: true }, undefined);
  const next = mocks.write.mock.calls[0]![0].sourceConfig;
  expect(next.plugins.entries.example.config.items).toEqual([
    {
      label: "first",
      key: {
        source: "store",
        provider: "default",
        id: storeName(target),
      },
    },
    { label: "second", key: "synthetic-unrelated" },
  ]);
});
