import { userInfo } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as bundleLsp from "../plugins/bundle-lsp.js";
import { noteBundleLspEnvPassthrough } from "./doctor-bundle-lsp-env.js";

const { shouldManageGatewayService } = vi.hoisted(() => ({
  shouldManageGatewayService: vi.fn(async () => false),
}));
vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService,
}));

const noteFn = vi.fn();
const service = { readCommand: vi.fn() };
const docsUrl = "https://docs.openclaw.ai/plugins/bundles#lsp-server-environment";

function lspConfig(
  servers: Record<string, Record<string, unknown>>,
): typeof bundleLsp.loadEnabledBundleLspConfig {
  return vi.fn(() => ({ config: { lspServers: servers }, diagnostics: [] }));
}

const gopls = { gopls: { command: "gopls", args: ["serve"] } };
const gatewayEnv = {
  HTTPS_PROXY: ["http://user", "proxy-pass-canary@proxy.example:3128"].join(":"),
  ANDROID_HOME: "/srv/android-canary",
  NPM_TOKEN: "npm-token-canary",
  OPENAI_API_KEY: "provider-key-canary",
};

beforeEach(() => {
  noteFn.mockReset();
  service.readCommand.mockReset().mockResolvedValue(null);
  shouldManageGatewayService.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.restoreAllMocks());

async function diagnose(
  options: Partial<Parameters<typeof noteBundleLspEnvPassthrough>[0]> & {
    loadLspConfig?: typeof bundleLsp.loadEnabledBundleLspConfig;
  } = {},
): Promise<string | undefined> {
  const { loadLspConfig = lspConfig(gopls), ...params } = options;
  vi.spyOn(bundleLsp, "loadEnabledBundleLspConfig").mockImplementation(loadLspConfig);
  await noteBundleLspEnvPassthrough({
    cfg: {},
    workspaceDirs: ["/synthetic/workspace"],
    env: gatewayEnv,
    service,
    noteFn,
    ...params,
  });
  return noteFn.mock.calls[0]?.[0];
}

it("names withheld Gateway variables per configured server, never values or secrets", async () => {
  const text = await diagnose();

  expect(noteFn).toHaveBeenCalledExactlyOnceWith(expect.any(String), "Bundle LSP environment");
  expect(text).toContain(`- "gopls": ANDROID_HOME: add to the server's "env"`);
  expect(text).toContain(`- "gopls": HTTPS_PROXY: refused by the host exec env policy`);
  expect(text).toContain(docsUrl);
  expect(text).not.toMatch(/NPM_TOKEN|OPENAI_API_KEY|canary|proxy-pass|proxy\.example/);
});

it("stays quiet without configured bundle LSP servers", async () => {
  expect(await diagnose({ loadLspConfig: lspConfig({}) })).toBeUndefined();
  expect(
    await diagnose({ loadLspConfig: lspConfig({ remote: { transport: "socket" } }) }),
  ).toBeUndefined();
});

it("stays quiet when no commonly needed variable is set", async () => {
  expect(await diagnose({ env: { OPENAI_API_KEY: "provider-key-canary" } })).toBeUndefined();
});

it("skips remote Gateways", async () => {
  expect(await diagnose({ cfg: { gateway: { mode: "remote" } } })).toBeUndefined();
});

it("omits a name the server's own env supplies", async () => {
  const text = await diagnose({
    env: { ANDROID_HOME: "/srv/android", DOTNET_ROOT: "/srv/dotnet" },
    loadLspConfig: lspConfig({
      gopls: { command: "gopls", env: { ANDROID_HOME: "/bundle/android" } },
    }),
  });

  expect(text).toContain(`- "gopls": DOTNET_ROOT: add to the server's "env"`);
  expect(text).not.toContain("ANDROID_HOME");
});

it("evaluates each workspace's config when workspaces reuse a server name", async () => {
  const configs: Record<string, Record<string, Record<string, unknown>>> = {
    "/synthetic/android-a": {
      kotlin: { command: "kotlin-lsp", env: { ANDROID_HOME: "/bundle/android" } },
    },
    "/synthetic/android-b": { kotlin: { command: "kotlin-lsp" } },
  };
  const loadLspConfig = vi.fn(({ workspaceDir }: { workspaceDir: string }) => ({
    config: { lspServers: configs[workspaceDir] ?? {} },
    diagnostics: [],
  })) as unknown as typeof bundleLsp.loadEnabledBundleLspConfig;

  const text = await diagnose({
    workspaceDirs: Object.keys(configs),
    env: { ANDROID_HOME: "/srv/android" },
    loadLspConfig,
  });

  expect(loadLspConfig).toHaveBeenCalledTimes(2);
  expect(text).toContain(`- "kotlin": ANDROID_HOME: add to the server's "env"`);
  expect(text).not.toMatch(/\/srv\/android|\/bundle\/android/);
});

it("includes the installed Gateway service environment", async () => {
  shouldManageGatewayService.mockResolvedValue(true);
  service.readCommand.mockResolvedValue({
    programArguments: [],
    environment: { VIRTUAL_ENV: "/srv/venv-canary" },
  });

  const text = await diagnose({ env: { HOME: userInfo().homedir } });

  expect(text).toContain(`- "gopls": VIRTUAL_ENV: refused by the host exec env policy`);
  expect(text).not.toContain("venv-canary");
});

it("does not read the installed service for a non-default install identity", async () => {
  shouldManageGatewayService.mockResolvedValue(true);
  service.readCommand.mockResolvedValue({
    programArguments: [],
    environment: { VIRTUAL_ENV: "/srv/venv" },
  });

  expect(await diagnose({ env: { HOME: "/srv/relocated-home" } })).toBeUndefined();
  expect(service.readCommand).not.toHaveBeenCalled();
});
