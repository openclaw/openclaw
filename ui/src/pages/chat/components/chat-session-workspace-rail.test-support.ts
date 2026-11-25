import { createComponent, createSignal, flush, onSettled } from "solid-js";
import { onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { stubTargetRetainingObserver } from "../../../test-helpers/resize-observer.ts";
import { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

type List = NonNullable<SessionWorkspaceProps["list"]>;
type WorkspaceFixture = Omit<Partial<SessionWorkspaceProps>, "list"> & {
  list?: Omit<List, "sessionKey">;
};

export function createWorkspace(overrides: WorkspaceFixture = {}): SessionWorkspaceProps {
  return {
    sessionKey: "agent:main:workspace",
    loading: false,
    readResult: overrides.loading ? new Promise<void>(() => {}) : undefined,
    error: null,
    activeId: null,
    filter: "all",
    browserPath: "",
    browserSearch: "",
    onBrowsePath: vi.fn(),
    onRetry: vi.fn(),
    onOpenFile: vi.fn(),
    onSearch: vi.fn(),
    onSetFilter: vi.fn(),
    onOpenArtifact: vi.fn(),
    ...overrides,
    list: overrides.list ? { sessionKey: "agent:main:workspace", ...overrides.list } : null,
  };
}

export async function mountWorkspace(workspace: SessionWorkspaceProps) {
  const [current, setCurrent] = createSignal(workspace);
  const view = mountSolid(() =>
    createComponent(SessionWorkspaceRail, {
      get workspace() {
        return current();
      },
    }),
  );
  if (!workspace.loading) {
    await new Promise<void>((resolve) => {
      onSettled(resolve);
    });
    flush();
  }
  return {
    ...view,
    update(this: void, next: SessionWorkspaceProps = workspace) {
      setCurrent({ ...next });
      flush();
    },
  };
}

type WorkspaceFile = NonNullable<SessionWorkspaceProps["list"]>["files"][number];
export function file(path: string, kind: WorkspaceFile["kind"] = "modified"): WorkspaceFile {
  return { path, name: path.split(/[\\/]/).at(-1)!, kind, missing: false };
}

export function setupDesktopLayout() {
  // JSDOM has no layout observation or font loading. These tests exercise the
  // workspace owner; real-browser proof owns overflow and disclosure motion.
  stubTargetRetainingObserver("ResizeObserver");
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.assign(new EventTarget(), { ready: Promise.resolve() }),
  });
  onTestFinished(() => {
    if (previousFonts) {
      Object.defineProperty(document, "fonts", previousFonts);
    } else {
      Reflect.deleteProperty(document, "fonts");
    }
  });
}
