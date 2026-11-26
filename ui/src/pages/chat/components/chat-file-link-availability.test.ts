/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { SessionWorkspaceStatResult } from "../../../api/types.ts";
import { checkFileLinkAvailability } from "./chat-file-link-availability.ts";
import type {
  SessionWorkspaceHost,
  SessionWorkspaceState,
} from "./chat-session-workspace-types.ts";

function render(html: string) {
  document.body.innerHTML = html;
  return [...document.body.getElementsByTagName("a")];
}

function host(answer: (files: { path: string }[]) => SessionWorkspaceStatResult | null) {
  const statFiles = vi.fn(async (_key: string, files: { path: string }[]) => answer(files));
  return { state: { sessions: { statFiles } } as unknown as SessionWorkspaceHost, statFiles };
}

const missingFor = (missing: string[]) => (files: { path: string }[]) => ({
  sessionKey: "agent:main:main",
  files: files.map(({ path }) => ({
    path,
    status: missing.includes(path) ? ("missing" as const) : ("file" as const),
  })),
});

it("turns links the Gateway cannot open into text and reuses answers", async () => {
  const workspace = { sessionKey: "agent:main:main", agentId: "main" } as SessionWorkspaceState;
  const { state, statFiles } = host(missingFor(["~/remote/reset.sh"]));
  const links = render(
    '<div data-entry-id="e1"><a data-file-path="~/remote/reset.sh"><code>reset.sh</code></a>' +
      '<a data-file-path="src/app.ts">app.ts</a></div>' +
      '<div data-file-session-key="agent:main:subagent:x"><a data-file-path="src/app.ts">a</a></div>',
  );

  await checkFileLinkAvailability(state, workspace, links);

  expect(statFiles.mock.calls).toEqual([
    [
      "agent:main:main",
      [
        { path: "~/remote/reset.sh", messageEntryId: "e1" },
        { path: "src/app.ts", messageEntryId: "e1" },
      ],
      { agentId: "main" },
    ],
    ["agent:main:subagent:x", [{ path: "src/app.ts" }], { agentId: "main" }],
  ]);
  expect(document.body.innerHTML).toContain(
    '<span data-file-path="~/remote/reset.sh"><code>reset.sh</code></span>',
  );
  expect(document.body.getElementsByTagName("a")).toHaveLength(2);

  // A re-rendered link reuses the answer without another request.
  await checkFileLinkAvailability(
    state,
    workspace,
    render('<div data-entry-id="e1"><a data-file-path="~/remote/reset.sh">reset.sh</a></div>'),
  );
  expect(statFiles).toHaveBeenCalledTimes(2);
  expect(document.body.getElementsByTagName("a")).toHaveLength(0);
});

it("keeps keyboard focus on a link that turns into text", async () => {
  const workspace = { sessionKey: "agent:main:main", agentId: "main" } as SessionWorkspaceState;
  const { state } = host(missingFor(["~/remote/reset.sh"]));
  const links = render('<a tabindex="0" data-file-path="~/remote/reset.sh">reset.sh</a>');
  links[0]!.focus();
  await checkFileLinkAvailability(state, workspace, links);
  expect(document.activeElement?.outerHTML).toBe(
    '<span data-file-path="~/remote/reset.sh" tabindex="-1">reset.sh</span>',
  );
});

it("keeps links when the Gateway cannot answer or answers out of order", async () => {
  const workspace = { sessionKey: "agent:main:main", agentId: "main" } as SessionWorkspaceState;
  for (const answer of [
    () => null,
    (files: { path: string }[]) => missingFor([])(files.toReversed()),
  ]) {
    const { state, statFiles } = host(answer);
    const links = render('<a data-file-path="src/a.ts">a</a><a data-file-path="src/b.ts">b</a>');
    await checkFileLinkAvailability(state, workspace, links);
    await checkFileLinkAvailability(state, workspace, links);
    expect(statFiles).toHaveBeenCalledTimes(2);
    expect(document.body.getElementsByTagName("a")).toHaveLength(2);
  }
});

it("does not probe a workspace the session row says this viewer cannot read", async () => {
  const workspace = { sessionKey: "agent:main:main", agentId: "main" } as SessionWorkspaceState;
  const { state, statFiles } = host(missingFor([]));
  Object.assign(state, { sessionWorkspaceReadDisabledReason: "Your operator role requires…" });
  const links = render(
    '<a data-file-path="src/a.ts">a</a>' +
      '<div data-file-session-key="agent:main:subagent:x"><a data-file-path="src/b.ts">b</a></div>',
  );
  await checkFileLinkAvailability(state, workspace, links);
  expect(statFiles.mock.calls).toEqual([
    ["agent:main:subagent:x", [{ path: "src/b.ts" }], { agentId: "main" }],
  ]);
  expect(document.body.getElementsByTagName("a")).toHaveLength(2);
});
