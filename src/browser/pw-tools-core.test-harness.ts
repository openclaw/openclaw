import { beforeEach, vi } from "vitest";

let currentPage: Record<string, unknown> | null = null;
let currentRefLocator: Record<string, unknown> | null = null;
let pageState: {
  console: unknown[];
  armIdUpload: number;
  armIdDialog: number;
  armIdDownload: number;
} = {
  console: [],
  armIdUpload: 0,
  armIdDialog: 0,
  armIdDownload: 0,
};

const sessionMocks = vi.hoisted(() => ({
  getPageForTargetId: vi.fn(async () => {
    if (!currentPage) {
      throw new Error("missing page");
    }
    return currentPage;
  }),
  ensurePageState: vi.fn(() => pageState),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  refLocator: vi.fn(() => {
    if (!currentRefLocator) {
      throw new Error("missing locator");
    }
    return currentRefLocator;
  }),
  rememberRoleRefsForTarget: vi.fn(() => {}),
}));

vi.mock("./pw-session.js", () => sessionMocks);

export function getPwToolsCoreSessionMocks() {
  return sessionMocks;
}

export function setPwToolsCoreCurrentPage(page: Record<string, unknown> | null) {
  currentPage = page;
}

export function setPwToolsCoreCurrentRefLocator(locator: Record<string, unknown> | null) {
  currentRefLocator = locator;
}

export function installPwToolsCoreTestHooks() {
  beforeEach(() => {
    currentPage = null;
    currentRefLocator = null;
    pageState = {
      console: [],
      armIdUpload: 0,
      armIdDialog: 0,
      armIdDownload: 0,
    };

    for (const fn of Object.values(sessionMocks)) {
      fn.mockClear();
    }
  });
}
