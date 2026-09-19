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

function request(overrides: Partial<GatewayRequestHandlerOptions> = {}) {
  return {
    params: { pluginId: "example", path, baseHash: "public:revision" },
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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot.mockResolvedValue({
    hash: "revision",
    sourceConfig: {
      plugins: { entries: { example: { config: { key: ref, other: "never-return-this" } } } },
    },
  });
  mocks.metadata.mockReturnValue({ byPluginId: new Map([["example", { id: "example" }]]) });
  mocks.descriptors.mockReturnValue([{ path, label: "Key", envVars: [] }]);
});
describe("plugin credential inspection authorization", () => {
  it("returns only the advertised reference and a public revision", async () => {
    expect(await invoke(request())).toHaveBeenCalledWith(
      true,
      { baseHash: "public:revision", credential: { kind: "reference", ref, unresolved: false } },
      undefined,
    );
  });
  it("rejects read-only access before reading unredacted config", async () => {
    const options = request();
    options.client!.connect.scopes = ["operator.read"];
    expect(await invoke(options)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it("rejects a connection retired while the snapshot read is pending", async () => {
    const options = request();
    mocks.snapshot.mockImplementation(async () => {
      options.client!.invalidated = true;
      return { hash: "revision" };
    });
    expect(await invoke(options)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mocks.metadata).not.toHaveBeenCalled();
  });
  it.each([
    { pluginId: "example", path, baseHash: "old" },
    { pluginId: "other", path, baseHash: "public:revision" },
    { pluginId: "example", path: [...path.slice(0, -1), "other"], baseHash: "public:revision" },
    { pluginId: "example", path, baseHash: "public:revision", resolve: true },
  ])(
    "rejects stale revisions, cross-plugin or arbitrary paths, and extra parameters",
    async (params) => {
      expect(await invoke(request({ params }))).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
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
