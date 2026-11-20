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
  const statFiles = vi.fn(async (_method: string, params: { files: { path: string }[] }) =>
    answer(params.files),
  );
  return {
    state: { client: { request: statFiles } } as unknown as SessionWorkspaceHost,
    statFiles,
  };
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
  render(
    '<div data-entry-id="e1"><a data-file-path="~/remote/reset.sh"><code>reset.sh</code></a>' +
      '<a data-file-path="src/app.ts">app.ts</a></div>' +
      '<div data-file-session-key="agent:main:subagent:x"><a data-file-path="src/app.ts">a</a></div>',
  );

  await checkFileLinkAvailability(state, workspace, document.body);

  expect(statFiles.mock.calls).toEqual([
    [
      "sessions.files.stat",
      {
        sessionKey: "agent:main:main",
        files: [
          { path: "~/remote/reset.sh", messageEntryId: "e1" },
          { path: "src/app.ts", messageEntryId: "e1" },
        ],
        agentId: "main",
      },
    ],
    [
      "sessions.files.stat",
      { sessionKey: "agent:main:subagent:x", files: [{ path: "src/app.ts" }], agentId: "main" },
    ],
  ]);
  expect(document.body.innerHTML).toContain(
    '<span data-file-path="~/remote/reset.sh"><code>reset.sh</code></span>',
  );
  expect(document.body.getElementsByTagName("a")).toHaveLength(2);

  // A re-rendered link reuses the answer without another request.
  render('<div data-entry-id="e1"><a data-file-path="~/remote/reset.sh">reset.sh</a></div>');
  await checkFileLinkAvailability(state, workspace, document.body);
  expect(statFiles).toHaveBeenCalledTimes(2);
  expect(document.body.getElementsByTagName("a")).toHaveLength(0);
});

it("keeps keyboard focus on a link that turns into text", async () => {
  const workspace = { sessionKey: "agent:main:main", agentId: "main" } as SessionWorkspaceState;
  const { state } = host(missingFor(["~/remote/reset.sh"]));
  const links = render('<a tabindex="0" data-file-path="~/remote/reset.sh">reset.sh</a>');
  links[0]!.focus();
  await checkFileLinkAvailability(state, workspace, document.body);
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
    const html = '<a data-file-path="src/a.ts">a</a><a data-file-path="src/b.ts">b</a>';
    render(html);
    await checkFileLinkAvailability(state, workspace, document.body);
    // Unanswered checks are forgotten, so a re-rendered link asks again.
    render(html);
    await checkFileLinkAvailability(state, workspace, document.body);
    expect(statFiles).toHaveBeenCalledTimes(2);
    expect(document.body.getElementsByTagName("a")).toHaveLength(2);
  }
});
