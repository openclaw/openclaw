/* @vitest-environment jsdom */

import { createSignal, flush, onSettled } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createGatewayRequestMock } from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createGatewayBrowserClientFixture } from "../chat-application-context.test-support.ts";
import { createSessionCapabilityFixture } from "../chat-session-capability.test-support.ts";
import { createSessionWorkspaceHost } from "./chat-session-workspace-host.test-support.ts";
import { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";
import {
  createWorkspace,
  file,
  mountWorkspace,
  setupDesktopLayout,
} from "./chat-session-workspace-rail.test-support.ts";
import { clearWorkspaceTimer, sessionWorkspaceForHost } from "./chat-session-workspace-state.ts";
import {
  createSessionWorkspaceProps,
  type SessionWorkspaceHost,
} from "./chat-session-workspace.ts";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

beforeEach(setupDesktopLayout);
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("keeps a recursive browser download until an admitted search removes it", async () => {
  type List = NonNullable<SessionWorkspaceProps["list"]>;
  const listing: List = {
    sessionKey: "agent:main:files",
    root: "/workspace",
    files: [],
    browser: { path: "", entries: [{ kind: "directory", path: "reports", name: "reports" }] },
  };
  const path = "reports/annual/report.md";
  const queries: { query: string; response: ReturnType<typeof createDeferred<List>> }[] = [];
  const listFiles = vi
    .fn<SessionWorkspaceHost["sessions"]["listFiles"]>()
    .mockResolvedValueOnce(listing)
    .mockImplementation((_key, options) => {
      const response = createDeferred<List>();
      queries.push({ query: options?.search ?? "", response });
      return response.promise;
    });
  const download = createDeferred<{ url: string; filename: string }>();
  const request = createGatewayRequestMock((method) =>
    method === "sessions.files.download" ? download.promise : { artifacts: [] },
  );
  const save = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  onTestFinished(() => save.mockRestore());
  const state = createSessionWorkspaceHost({
    agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [] },
    client: createGatewayBrowserClientFixture({
      gatewayUrl: location.origin.replace(/^http/, "ws"),
      request,
    }),
    sessions: createSessionCapabilityFixture({ listFiles }),
  });
  const props = () => createSessionWorkspaceProps(state, { expanded: true });
  const [current, setCurrent] = createSignal(props());
  const mounted = mountSolid(() => <SessionWorkspaceRail workspace={current()} />);
  const stop = sessionWorkspaceForHost(state).subscribe(() => setCurrent(props()));
  onTestFinished(() => {
    clearWorkspaceTimer(state.sessionWorkspaceState);
    stop();
    mounted.unmount();
    for (const query of queries) {
      query.response.resolve(listing);
    }
  });
  await waitForSolid(() =>
    expect(mounted.queryByRole("button", { name: "reports" })).not.toBeNull(),
  );
  const accept = async (query: string, include: boolean) => {
    queries.at(-1)!.response.resolve({
      ...listing,
      browser: {
        path: "",
        search: query,
        entries: include ? [{ kind: "file", path, name: "report.md" }] : [],
      },
    });
    await state.sessionWorkspaceState!.readResult;
    flush();
  };
  current().onSearch("report");
  await vi.waitFor(() => expect(queries).toHaveLength(1));
  await accept("report", true);
  const action = mounted.getByRole("button", { name: "Download file" });
  const copy = mounted.getByRole("button", { name: "Copy path" });
  action.click();
  action.click();
  await vi.waitFor(() =>
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.files.download"),
    ).toHaveLength(1),
  );
  const call = request.mock.calls.find(([method]) => method === "sessions.files.download")!;
  expect(call[1]).toMatchObject({ path: "/workspace/" + path });
  for (const [index, query] of ["rep", "absent"].entries()) {
    current().onSearch(query);
    await vi.waitFor(() => expect(queries).toHaveLength(index + 2));
    copy.focus();
    expect(queries.at(-1)!.query).toBe(query);
    expect(mounted.getByRole("button", { name: /^Download/ })).toBe(action);
    expect(mounted.container.textContent).toContain(
      "Search results: " + (index ? "rep" : "report"),
    );
    expect(call[2]?.signal?.aborted).toBe(false);
    expect(document.activeElement).toBe(copy);
    await accept(query, index === 0);
    if (index === 0) {
      expect(mounted.getByRole("button", { name: /^Download/ })).toBe(action);
      expect(document.activeElement).toBe(copy);
    }
  }
  await waitForSolid(() => expect(call[2]?.signal?.aborted).toBe(true));
  expect(mounted.queryByRole("button", { name: /^Download/ })).toBeNull();
  download.resolve({ filename: "report.md", url: "/api/artifacts/download/connection/ticket" });
  await download.promise;
  await new Promise<void>((resolve) => {
    onSettled(resolve);
  });
  expect(save).not.toHaveBeenCalled();
});

it("navigates default directory search hits without opening them as files", async () => {
  const browse = vi.fn();
  const open = vi.fn();
  const mounted = await mountWorkspace(
    createWorkspace({
      browserSearch: "reports",
      onBrowsePath: browse,
      onOpenFile: open,
      list: {
        files: [],
        browser: {
          path: "",
          search: "reports",
          entries: [{ kind: "directory", path: "reports/monthly", name: "monthly" }],
        },
      },
    }),
  );
  onTestFinished(mounted.unmount);
  const directory = mounted.getByRole("button", { name: "reports/monthly" });
  directory.click();
  expect(browse).toHaveBeenCalledExactlyOnceWith("reports/monthly");
  expect(open).not.toHaveBeenCalled();
  expect(mounted.queryByRole("button", { name: "Download file" })).toBeNull();
  expect(directory.hasAttribute("aria-expanded")).toBe(false);
});

it.each(
  (["session", "workspace"] as const).flatMap((origin) =>
    (["connection", "presentation"] as const).map((changed) => ({
      origin,
      changed,
    })),
  ),
)(
  "keeps default $origin downloads bound to visible files through $changed changes",
  async ({ origin, changed }) => {
    const pending =
      createDeferred<Awaited<ReturnType<NonNullable<SessionWorkspaceProps["onDownloadFile"]>>>>();
    const download = vi.fn(
      (_path: string, _origin: "session" | "workspace", _signal: AbortSignal) => pending.promise,
    );
    const save = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    onTestFinished(() => save.mockRestore());
    const workspace = createWorkspace({
      connectionEpoch: 1,
      onDownloadFile: download,
      list:
        origin === "session"
          ? { files: [file("report.md")] }
          : {
              files: [],
              browser: {
                path: "",
                entries: [{ kind: "file", path: "report.md", name: "report.md" }],
              },
            },
    });
    const mounted = await mountWorkspace(workspace);
    onTestFinished(mounted.unmount);
    const action = mounted.getByRole("button", { name: "Download file" });
    action.click();
    action.click();
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.slice(0, 2)).toEqual(["report.md", origin]);
    mounted.update(
      changed === "presentation"
        ? { ...workspace, presentation: "desktop" }
        : { ...workspace, connectionEpoch: 2 },
    );
    flush();
    if (changed === "presentation") {
      await waitForSolid(() => expect(download.mock.calls[0]?.[2].aborted).toBe(true));
    }
    pending.resolve({ filename: "report.md", url: "https://example.invalid/report.md" });
    await pending.promise;
    await new Promise<void>((resolve) => {
      onSettled(resolve);
    });
    await waitForSolid(() => expect(save).not.toHaveBeenCalled());
  },
);

it("keeps missing metadata and disables only the unavailable download", async () => {
  const download = vi.fn();
  const open = vi.fn();
  const workspace = createWorkspace({
    onDownloadFile: download,
    onOpenFile: open,
    list: { files: [{ ...file("missing.md"), missing: true, size: 2048 }] },
  });
  const mounted = await mountWorkspace(workspace);
  onTestFinished(mounted.unmount);
  expect(mounted.container.textContent).toContain("2 KB");
  expect(mounted.container.textContent).toContain("Missing");
  expect(mounted.getByRole("button", { name: "Download file" }).hasAttribute("disabled")).toBe(
    true,
  );
  mounted.getByRole("button", { name: "Preview" }).click();
  expect(open).toHaveBeenCalledExactlyOnceWith("missing.md", "session", undefined);
  expect(download).not.toHaveBeenCalled();
});
