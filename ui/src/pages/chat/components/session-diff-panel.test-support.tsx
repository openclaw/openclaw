import { createSignal } from "solid-js";
import type { SessionsDiffResult } from "../../../../../packages/gateway-protocol/src/index.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import type { SessionDiffProps } from "./chat-sidebar-content-types.ts";
import { SessionDiffPanel } from "./session-diff-panel.tsx";

export function mountPanel() {
  const [props, setProps] = createSignal<SessionDiffProps>({
    owner: null,
    execNode: null,
    loader: null,
    loadFileText: null,
    openFile: null,
    revealFile: null,
  });
  const view = mountSolid(() => <SessionDiffPanel {...props()} />);
  return {
    panel: view.container.querySelector<HTMLElement>("openclaw-session-diff")!,
    unmount: view.unmount,
    update: (patch: Partial<SessionDiffProps>) => setProps((current) => ({ ...current, ...patch })),
  };
}

export function result(branch: string): SessionsDiffResult {
  return {
    sessionKey: "agent:main:test",
    branch,
    baseRef: "main",
    files: [],
    additions: 0,
    deletions: 0,
  };
}

export const SNAPSHOT_PATCH = [
  "--- a/example.txt",
  "+++ b/example.txt",
  "@@ -3 +3 @@",
  "-before",
  "+snapshot line",
].join("\n");

export const FRESH_PATCH = [
  "--- a/example.txt",
  "+++ b/example.txt",
  "@@ -1,3 +1,3 @@",
  " fresh gap edit",
  " context",
  "-before",
  "+fresh snapshot line",
].join("\n");

export function fileResult(patch: string): SessionsDiffResult {
  return {
    sessionKey: "agent:main:test",
    branch: "feature/test",
    baseRef: "main",
    files: [{ path: "example.txt", status: "modified", additions: 1, deletions: 1, patch }],
    additions: 1,
    deletions: 1,
  };
}
