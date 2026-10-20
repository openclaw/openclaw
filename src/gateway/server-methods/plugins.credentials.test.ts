import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginCredentialHandlers } from "./plugins.credentials.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), metadata: vi.fn(), descriptors: vi.fn() }));
vi.mock("../../config/config.js", () => ({ readConfigFileSnapshot: mocks.snapshot }));
vi.mock("../../plugins/management-service.js", () => ({
  resolveManagedPluginMetadata: mocks.metadata,
}));
vi.mock("../../plugins/credential-descriptors.js", () => ({
  resolvePluginCredentialDescriptors: mocks.descriptors,
}));
const path = ["plugins", "entries", "example", "config", "key"];
const ref = { source: "file", provider: "vault", id: "/private/key" };
const inspectParams = { pluginId: "example", path, baseHash: "public:revision" };
const revealParams = { ...inspectParams, reveal: true };
const invalidRequest = expect.objectContaining({ code: "INVALID_REQUEST" });

function request(overrides: Partial<GatewayRequestHandlerOptions> = {}) {
  return {
    params: inspectParams,
    client: { connect: { scopes: ["operator.admin"] } },
    context: {
      getRuntimeConfig: () => ({}),
      configRevisionProjector: { projectRawHash: (hash: string) => `public:${hash}` },
    },
    respond: vi.fn(),
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}
async function invoke(options: GatewayRequestHandlerOptions) {
  await pluginCredentialHandlers["plugins.credentials.inspect"]!(options);
  return options.respond;
}
function snapshot(key: unknown, other: string) {
  return {
    hash: "revision",
    sourceConfig: { plugins: { entries: { example: { config: { key, other } } } } },
  };
}
async function expectCredential(credential: unknown, reveal = false) {
  expect(
    await invoke(request({ params: reveal ? revealParams : inspectParams })),
  ).toHaveBeenCalledWith(true, { baseHash: "public:revision", credential }, undefined);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot.mockResolvedValue(snapshot(ref, "never-return-this"));
  mocks.metadata.mockReturnValue({ byPluginId: new Map([["example", { id: "example" }]]) });
  mocks.descriptors.mockReturnValue([{ path, label: "Key", envVars: [] }]);
});
describe("plugin credential inspection authorization", () => {
  it("returns only the advertised reference and a public revision", async () => {
    await expectCredential({ kind: "reference", ref, unresolved: false });
  });
  it("returns only the requested authored literal after an explicit reveal", async () => {
    mocks.snapshot.mockResolvedValue(snapshot("synthetic-private", "other-private"));
    await expectCredential({ kind: "literal" });
    await expectCredential({ kind: "literal", value: "synthetic-private" }, true);
  });
  it("rejects read-only reveal access before reading config", async () => {
    const options = request({ params: revealParams });
    options.client!.connect.scopes = ["operator.read"];
    expect(await invoke(options)).toHaveBeenCalledWith(false, undefined, invalidRequest);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it("rejects a connection retired while the snapshot read is pending", async () => {
    const options = request({ params: revealParams });
    mocks.snapshot.mockImplementation(async () => {
      options.client!.invalidated = true;
      return { hash: "revision" };
    });
    expect(await invoke(options)).toHaveBeenCalledWith(false, undefined, invalidRequest);
    expect(mocks.metadata).not.toHaveBeenCalled();
  });
  it.each([
    { ...revealParams, baseHash: "old" },
    { pluginId: "example", path, reveal: true },
    { ...revealParams, pluginId: "other" },
    { ...revealParams, path: [...path.slice(0, -1), "other"] },
    { ...inspectParams, resolve: true },
  ])(
    "rejects stale revisions, cross-plugin or arbitrary paths, and extra parameters",
    async (params) => {
      expect(await invoke(request({ params }))).toHaveBeenCalledWith(
        false,
        undefined,
        invalidRequest,
      );
    },
  );
  it("does not echo authored text from loader errors", async () => {
    mocks.snapshot.mockRejectedValue(new Error("private-secret-from-invalid-config"));
    const respond = await invoke(request());
    expect(JSON.stringify(vi.mocked(respond).mock.calls)).not.toContain("private-secret");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });
});
