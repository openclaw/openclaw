import { vi } from "vitest";
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
import { createBrowserProgram } from "./browser-cli-test-helpers.js";

type BrowserRequest = { path?: string };
type BrowserRuntimeOptions = { timeoutMs?: number };

export type BrowserManageCall = [unknown, BrowserRequest, BrowserRuntimeOptions | undefined];

const browserManageMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn<
    (
      opts: unknown,
      req: BrowserRequest,
      runtimeOpts?: BrowserRuntimeOptions,
    ) => Promise<Record<string, unknown>>
  >(async (_opts: unknown, req: BrowserRequest) =>
    req.path === "/"
      ? {
          enabled: true,
          running: true,
          pid: 1,
          cdpPort: 18800,
          chosenBrowser: "chrome",
          userDataDir: "/tmp/openclaw",
          color: "blue",
          headless: true,
          attachOnly: false,
        }
      : {},
  ),
}));

vi.mock("./browser-cli-shared.js", () => ({
  callBrowserRequest: browserManageMocks.callBrowserRequest,
}));

vi.mock("./cli-utils.js", async () => ({
  ...(await (await import("./browser-cli-test-helpers.js")).createBrowserCliUtilsMockModule()),
}));

vi.mock(
  "../runtime.js",
  async () =>
    await (await import("./browser-cli-test-helpers.js")).createBrowserCliRuntimeMockModule(),
);

export function createBrowserManageProgram(params?: { withParentTimeout?: boolean }) {
  const { program, browser, parentOpts } = createBrowserProgram();
  if (params?.withParentTimeout) {
    browser.option("--timeout <ms>", "Timeout in ms", "30000");
  }
  registerBrowserManageCommands(browser, parentOpts);
  return program;
}

export function getBrowserManageCallBrowserRequestMock() {
  return browserManageMocks.callBrowserRequest;
}

export function findBrowserManageCall(path: string): BrowserManageCall | undefined {
  return browserManageMocks.callBrowserRequest.mock.calls.find(
    (call) => (call[1] ?? {}).path === path,
  ) as BrowserManageCall | undefined;
}
