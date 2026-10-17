/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentsFilesSetResult,
  AgentsListResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  createAgentsPage,
  gateway,
  pageContext,
  snapshot as gatewaySnapshot,
} from "./agents-page.test-support.ts";
import { Agents } from "./view.tsx";

const AGENT_FILE_GATEWAY_HELLO = gatewayHelloForMethods(["agents.files.set"]);

function filePage(
  currentGateway: ApplicationContext["gateway"],
  agents: ApplicationContext["agents"],
) {
  const context = pageContext(currentGateway, agents);
  const page = createAgentsPage(
    context,
    agentsRouteData(currentGateway, undefined, "main", context.settingsAgentSelection),
  );
  const files = () => page.read().agentFiles;
  const editor = () => files().agentFileEditors["AGENTS.md"];
  const loaded = (content: string) => vi.waitFor(() => expect(editor()?.content).toBe(content));
  return { page, files, editor, loaded };
}

function fileGateway(request: GatewayRequestHandler) {
  const client = { request } as unknown as GatewayBrowserClient;
  return gateway({
    ...gatewaySnapshot(client),
    hello: AGENT_FILE_GATEWAY_HELLO,
  });
}

function workspaceRequests(
  list: AgentsFilesListResult,
  content: string,
  roster: AgentsListResult = agentsList,
) {
  const result = {
    agentId: list.agentId,
    workspace: list.workspace,
    file: { ...list.files[0]!, content },
  };
  const lists = vi.fn(async () => list);
  const get = vi.fn(async (): Promise<AgentsFilesGetResult> => result);
  const set = vi.fn(async (): Promise<AgentsFilesSetResult> => {
    throw new Error("Unexpected write");
  });
  const handlers: Record<string, () => Promise<unknown>> = {
    "agents.list": async () => roster,
    "agents.files.list": lists,
    "agents.files.get": get,
    "agents.files.set": set,
  };
  const request = vi.fn(async (method: string) => {
    if (!Object.hasOwn(handlers, method)) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handlers[method]!();
  });
  return { request, list: lists, get, set };
}

async function workspacePage(request: GatewayRequestHandler) {
  const currentGateway = fileGateway(request);
  const agents = createAgentCapability(currentGateway);
  await agents.ensureFiles("main");
  await agents.ensureList();
  return { ...filePage(currentGateway, agents), agents };
}

function fileList(): AgentsFilesListResult {
  return {
    agentId: "main",
    workspace: "/tmp/workspace",
    files: [{ name: "AGENTS.md", path: "/tmp/workspace/AGENTS.md", missing: false }],
  };
}

describe("agent file lifecycle", () => {
  it("hydrates a file selected by an early list publication after list loading settles", async () => {
    const list = fileList();
    const request = vi.fn(async () => ({
      ...list,
      file: { ...list.files[0], content: "# Instructions" },
    }));
    const pending = createDeferred<AgentsFilesListResult>();
    type AgentListener = Parameters<ReturnType<typeof agentsCapability>["subscribe"]>[0];
    const listeners = new Set<AgentListener>();
    let published: AgentsFilesListResult | null = null;
    const agents = {
      ...agentsCapability(() => pending.promise),
      files: () => ({ list: published, loading: false, error: null }),
      recordFile: () => list,
      subscribe: (listener: AgentListener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const currentGateway = fileGateway(request);
    const { files, loaded } = filePage(currentGateway, agents);
    published = list;
    listeners.forEach((listener) => listener(agents.state));
    expect(files().agentFileActive).toBe("AGENTS.md");
    expect(request).not.toHaveBeenCalled();

    pending.resolve(list);
    await loaded("# Instructions");
  });

  it.each(["refresh", "rejected save"])("keeps a dirty draft visible after %s", async (action) => {
    const list = fileList();
    const failedSave = action === "rejected save";
    let content = failedSave ? "original" : "server revision 1";
    const request = vi.fn(async (method: string) => {
      if (method === "agents.files.get") {
        return { ...list, file: { ...list.files[0], content } };
      }
      throw new Error("workspace write failed");
    });
    const refreshFiles = vi.fn(async () => list);
    const { files, editor, loaded } = filePage(fileGateway(request), {
      ...agentsCapability(async () => list),
      refreshFiles,
      recordFile: () => list,
    });
    await loaded(content);
    files().onFileDraftChange("AGENTS.md", failedSave ? "updated" : "local draft");
    if (failedSave) {
      files().onFileSave("AGENTS.md");
      await vi.waitFor(() =>
        expect(request.mock.calls.filter(([method]) => method === "agents.files.set")).toHaveLength(
          1,
        ),
      );
      await vi.waitFor(() => expect(files().agentFilesError).toBe("workspace write failed"));
      expect(refreshFiles).not.toHaveBeenCalled();
    } else {
      content = "server revision 2";
      files().onLoadFiles("main");
      await loaded(content);
      expect(refreshFiles).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledTimes(2);
      expect(editor()).toMatchObject({ content: "server revision 2", draft: "local draft" });
    }
  });

  it.each(["content read", "file list", "invalidated cache"] as const)(
    "keeps saved file metadata through a pending %s and unrelated agent publication",
    async (pendingRequest) => {
      const missingFile = { name: "AGENTS.md", path: "/tmp/workspace/AGENTS.md", missing: true };
      const missingList = { ...fileList(), files: [missingFile] };
      const savedFile = { ...missingFile, missing: false, content: "saved content", size: 13 };
      const savedList = { ...missingList, files: [savedFile] };
      const savedResult = { agentId: "main", workspace: missingList.workspace, file: savedFile };
      const contentRead = createDeferred<AgentsFilesGetResult>();
      const listRead = createDeferred<AgentsFilesListResult>();
      const io = workspaceRequests(missingList, "", {
        defaultId: "main",
        agents: [{ id: "main" }],
      });
      io.list.mockResolvedValue(savedList).mockResolvedValueOnce(missingList);
      io.get.mockResolvedValue(savedResult).mockResolvedValueOnce({
        agentId: "main",
        workspace: missingList.workspace,
        file: { ...missingFile, content: "" },
      });
      if (pendingRequest === "file list") {
        io.list.mockReturnValueOnce(listRead.promise);
      } else {
        io.get.mockReturnValueOnce(contentRead.promise);
      }
      io.set.mockResolvedValue({ ok: true, ...savedResult });
      const { page, files, editor, loaded, agents } = await workspacePage(io.request);
      await loaded("");
      files().onFileDraftChange(missingFile.name, savedFile.content);
      files().onLoadFiles("main");
      if (pendingRequest !== "file list") {
        await vi.waitFor(() => expect(io.get).toHaveBeenCalledTimes(2));
      }

      try {
        expect(files().agentFilesLoading).toBe(true);
        if (pendingRequest === "invalidated cache") {
          agents.invalidateFiles(["main"]);
        }
        files().onFileSave(missingFile.name);
        await vi.waitFor(() => {
          expect(files().agentFileSaving).toBe(false);
          expect(editor()?.content).toBe(savedFile.content);
        });
        expect(files().agentFilesList?.files).toEqual([
          expect.objectContaining({ name: missingFile.name, missing: false, size: 13 }),
        ]);

        contentRead.resolve(savedResult);
        listRead.resolve(missingList);
        await vi.waitFor(() => expect(files().agentFilesLoading).toBe(false));
        expect(files().agentFilesList?.files).toEqual([
          expect.objectContaining({ name: missingFile.name, missing: false, size: 13 }),
        ]);
        expect(files().agentFileActive).toBe(missingFile.name);

        await agents.refreshList();

        expect(files().agentFilesList?.files).toEqual([
          expect.objectContaining({ name: missingFile.name, missing: false, size: 13 }),
        ]);
        expect(editor()).toMatchObject({ content: savedFile.content, draft: savedFile.content });
        expect(files().agentFilesError).toBeNull();
      } finally {
        page.dispose();
        contentRead.resolve(savedResult);
        listRead.resolve(missingList);
        agents.dispose();
      }
    },
  );

  it.each([false, true])(
    "renders a failed cache rebuild without replacing a newer save error: %s",
    async (newerSaveFails) => {
      const list = fileList();
      const savedContent = "saved content";
      const rebuildError = "workspace metadata refresh failed";
      const writeError = "newer workspace write failed";
      const rebuild = createDeferred<AgentsFilesListResult>();
      const io = workspaceRequests(list, "original");
      io.list.mockReturnValue(rebuild.promise).mockResolvedValueOnce(list);
      io.set.mockRejectedValue(new Error(writeError)).mockResolvedValueOnce({
        ok: true,
        agentId: "main",
        workspace: list.workspace,
        file: { ...list.files[0]!, content: savedContent },
      });
      const { page, files, editor, loaded, agents } = await workspacePage(io.request);
      await loaded("original");
      files().onFileDraftChange("AGENTS.md", savedContent);
      const mounted = mountSolid(Agents, page.read());
      const { container } = mounted;
      const saveDraft = () => {
        mounted.update(page.read());
        const button = container.querySelector<HTMLButtonElement>(
          ".agent-file-header .agent-file-actions button.primary",
        );
        expect(button?.disabled).toBe(false);
        button?.click();
      };

      try {
        agents.invalidateFiles(["main"]);
        saveDraft();
        await vi.waitFor(() => {
          expect(files().agentFileSaving).toBe(false);
          expect(editor()?.content).toBe(savedContent);
          expect(io.list).toHaveBeenCalledTimes(2);
        });
        if (newerSaveFails) {
          files().onFileDraftChange("AGENTS.md", "newer draft");
          saveDraft();
          await vi.waitFor(() => expect(files().agentFilesError).toBe(writeError));
        }
        rebuild.reject(new Error(rebuildError));
        await vi.waitFor(() => expect(agents.files("main").error).toBe(rebuildError));

        mounted.update(page.read());

        expect(container.querySelector(".callout.danger")?.textContent).toBe(
          newerSaveFails ? writeError : rebuildError,
        );
        expect(container.querySelector<HTMLTextAreaElement>(".agent-file-textarea")?.value).toBe(
          newerSaveFails ? "newer draft" : savedContent,
        );
        expect(editor()?.content).toBe(savedContent);
      } finally {
        page.dispose();
        rebuild.resolve(list);
        agents.dispose();
        mounted.dispose();
      }
    },
  );
});
