/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsFilesGetResult, AgentsFilesListResult } from "../../api/types.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
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

function snapshot(client: GatewayBrowserClient) {
  return { ...gatewaySnapshot(client), hello: AGENT_FILE_GATEWAY_HELLO };
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
    const client = { request } as unknown as GatewayBrowserClient;
    const pending = createDeferred<AgentsFilesListResult>();
    type AgentListener = Parameters<ReturnType<typeof agentsCapability>["subscribe"]>[0];
    const listeners = new Set<AgentListener>();
    let published: AgentsFilesListResult | null = null;
    let loading = false;
    const completion = pending.promise.then((result) => {
      loading = false;
      return { result };
    });
    let read: typeof completion | null = null;
    const agents = {
      ...agentsCapability(() => pending.promise),
      files: () => ({ list: published, loading, read }),
      ensureFiles: () => {
        loading = true;
        read = completion;
        return pending.promise;
      },
      recordFile: () => list,
      subscribe: (listener: AgentListener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const currentGateway = gateway(snapshot(client));
    const context = pageContext(currentGateway, agents);
    const page = createAgentsPage(
      context,
      agentsRouteData(currentGateway, agentsList, "main", context.settingsAgentSelection),
    );
    published = list;
    listeners.forEach((listener) => listener(agents.state));
    expect(page.read().readData().agentFileActive).toBe("AGENTS.md");
    expect(request).not.toHaveBeenCalled();

    pending.resolve(list);
    await vi.waitFor(() =>
      expect(page.read().readData().agentFileEditors["AGENTS.md"]?.content).toBe("# Instructions"),
    );

    expect(page.read().readData().agentFileEditors["AGENTS.md"]?.content).toBe("# Instructions");
  });

  it("keeps a failed initial inventory visible until an explicit retry", async () => {
    const list = fileList();
    const first = createDeferred<AgentsFilesListResult>();
    const retry = createDeferred<AgentsFilesListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "agents.files.list") {
        return ++listCalls === 1 ? await first.promise : await retry.promise;
      }
      if (method === "agents.list") {
        return agentsList;
      }
      if (method === "agents.files.get") {
        return { ...list, file: { ...list.files[0], content: "recovered" } };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const agents = createAgentCapability(currentGateway);
    await agents.ensureList();
    const initial = agents.ensureFiles("main");
    const context = pageContext(currentGateway, agents);
    const page = createAgentsPage(
      context,
      agentsRouteData(currentGateway, agentsList, "main", context.settingsAgentSelection),
    );
    const mounted = mountSolid(Agents, page.read());
    try {
      first.reject(new Error("initial inventory unavailable"));
      await initial;
      expect(listCalls).toBe(1);
      await vi.waitFor(() => {
        mounted.update(page.read());
        expect(mounted.container.querySelector(".callout.danger")?.textContent).toBe(
          "initial inventory unavailable",
        );
      });

      page.read().agentFiles.onLoadFiles("main");
      expect(listCalls).toBe(2);
      retry.resolve(list);
      await vi.waitFor(() => {
        mounted.update(page.read());
        expect(
          mounted.container.querySelector<HTMLTextAreaElement>(".agent-file-textarea")?.value,
        ).toBe("recovered");
        expect(mounted.container.querySelector(".callout.danger")).toBeNull();
      });
    } finally {
      page.dispose();
      agents.dispose();
      mounted.dispose();
    }
  });

  it("keeps an inventory refresh failure visible without rereading file content", async () => {
    const list = fileList();
    const refresh = createDeferred<AgentsFilesListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "agents.files.list") {
        return ++listCalls === 1 ? list : await refresh.promise;
      }
      if (method === "agents.list") {
        return agentsList;
      }
      if (method === "agents.files.get") {
        return { ...list, file: { ...list.files[0], content: "original" } };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const agents = createAgentCapability(currentGateway);
    await agents.ensureList();
    await agents.ensureFiles("main");
    const context = pageContext(currentGateway, agents);
    const page = createAgentsPage(
      context,
      agentsRouteData(currentGateway, agentsList, "main", context.settingsAgentSelection),
    );
    await vi.waitFor(() =>
      expect(page.read().readData().agentFileEditors["AGENTS.md"]?.content).toBe("original"),
    );
    const mounted = mountSolid(Agents, page.read());
    try {
      page.read().agentFiles.onLoadFiles("main");
      refresh.reject(new Error("workspace inventory unavailable"));
      await vi.waitFor(() => {
        mounted.update(page.read());
        expect(mounted.container.querySelector(".callout.danger")?.textContent).toBe(
          "workspace inventory unavailable",
        );
      });
      expect(request.mock.calls.filter(([method]) => method === "agents.files.get")).toHaveLength(
        1,
      );
      expect(
        mounted.container.querySelector<HTMLTextAreaElement>(".agent-file-textarea")?.value,
      ).toBe("original");
    } finally {
      page.dispose();
      agents.dispose();
      mounted.dispose();
    }
  });

  it("refreshes the active file base without replacing a dirty draft", async () => {
    const list = fileList();
    let authoritativeContent = "server revision 1";
    const request = vi.fn(async () => ({
      file: {
        ...list.files[0],
        content: authoritativeContent,
      },
    }));
    const refreshFiles = vi.fn(async () => list);
    const client = { request } as unknown as GatewayBrowserClient;
    const currentGateway = gateway(snapshot(client));
    const context = pageContext(currentGateway, {
      ...agentsCapability(async () => list),
      refreshFiles,
      recordFile: () => list,
    });
    const page = createAgentsPage(
      context,
      agentsRouteData(currentGateway, agentsList, "main", context.settingsAgentSelection),
    );
    await vi.waitFor(() =>
      expect(page.read().readData().agentFileEditors["AGENTS.md"]?.content).toBe(
        "server revision 1",
      ),
    );
    page.read().agentFiles.onFileDraftChange("AGENTS.md", "local draft");
    authoritativeContent = "server revision 2";

    page.read().agentFiles.onLoadFiles("main");
    await vi.waitFor(() =>
      expect(page.read().readData().agentFileEditors["AGENTS.md"]?.content).toBe(
        "server revision 2",
      ),
    );

    expect(refreshFiles).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(page.read().readData().agentFileEditors["AGENTS.md"]?.content).toBe("server revision 2");
    expect(page.read().readData().agentFileEditors["AGENTS.md"]?.draft).toBe("local draft");
  });

  it("keeps a rejected save visible without refreshing it away", async () => {
    const list = fileList();
    const request = vi.fn(async (method: string) => {
      if (method === "agents.files.get") {
        return { ...list, file: { ...list.files[0], content: "original" } };
      }
      throw new Error("workspace write failed");
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const refreshFiles = vi.fn(async () => list);
    const currentGateway = gateway(snapshot(client));
    const context = pageContext(currentGateway, {
      ...agentsCapability(async () => list),
      refreshFiles,
      recordFile: () => list,
    });
    const page = createAgentsPage(
      context,
      agentsRouteData(currentGateway, agentsList, "main", context.settingsAgentSelection),
    );
    await vi.waitFor(() =>
      expect(page.read().readData().agentFileEditors["AGENTS.md"]?.content).toBe("original"),
    );
    page.read().agentFiles.onFileDraftChange("AGENTS.md", "updated");
    void page.read().agentFiles.onFileSave("AGENTS.md");

    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "agents.files.set")).toHaveLength(
        1,
      ),
    );
    expect(await page.read().readData().agentFileOutcome).toEqual({
      error: "workspace write failed",
    });
    expect(refreshFiles).not.toHaveBeenCalled();
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
      let listCalls = 0;
      let contentCalls = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "agents.files.list") {
          listCalls += 1;
          if (listCalls === 1) {
            return missingList;
          }
          return pendingRequest === "file list" && listCalls === 2
            ? await listRead.promise
            : savedList;
        }
        if (method === "agents.files.get") {
          contentCalls += 1;
          if (contentCalls === 1) {
            return {
              agentId: "main",
              workspace: missingList.workspace,
              file: { ...missingFile, content: "" },
            };
          }
          return pendingRequest !== "file list" && contentCalls === 2
            ? await contentRead.promise
            : savedResult;
        }
        if (method === "agents.files.set") {
          return { ok: true, ...savedResult };
        }
        if (method === "agents.list") {
          return { defaultId: "main", agents: [{ id: "main" }] };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const currentGateway = gateway(snapshot(client));
      const agents = createAgentCapability(currentGateway);
      await agents.ensureFiles("main");
      await agents.ensureList();
      const context = pageContext(currentGateway, agents);
      const page = createAgentsPage(
        context,
        agentsRouteData(currentGateway, agentsList, "main", context.settingsAgentSelection),
      );
      await vi.waitFor(() =>
        expect(page.read().readData().agentFileEditors[missingFile.name]?.content).toBe(""),
      );
      page.read().agentFiles.onFileDraftChange(missingFile.name, savedFile.content);
      page.read().agentFiles.onLoadFiles("main");
      if (pendingRequest !== "file list") {
        await vi.waitFor(() => expect(contentCalls).toBe(2));
      }

      try {
        expect(page.read().readData().agentFilesLoading || agents.files("main").loading).toBe(true);
        if (pendingRequest === "invalidated cache") {
          agents.invalidateFiles(["main"]);
        }
        void page.read().agentFiles.onFileSave(missingFile.name);
        await vi.waitFor(() => {
          expect(page.read().readData().agentFileSaving).toBe(false);
          expect(page.read().readData().agentFileEditors[missingFile.name]?.content).toBe(
            savedFile.content,
          );
        });
        expect(page.read().readData().agentFilesList?.files).toEqual([
          expect.objectContaining({ name: missingFile.name, missing: false, size: 13 }),
        ]);

        contentRead.resolve(savedResult);
        listRead.resolve(missingList);
        await vi.waitFor(() => expect(page.read().readData().agentFilesLoading).toBe(false));
        expect(page.read().readData().agentFilesList?.files).toEqual([
          expect.objectContaining({ name: missingFile.name, missing: false, size: 13 }),
        ]);
        expect(page.read().readData().agentFileActive).toBe(missingFile.name);

        await agents.refreshList();

        expect(page.read().readData().agentFilesList?.files).toEqual([
          expect.objectContaining({ name: missingFile.name, missing: false, size: 13 }),
        ]);
        expect(page.read().readData().agentFileEditors[missingFile.name]?.content).toBe(
          savedFile.content,
        );
        expect(page.read().readData().agentFileEditors[missingFile.name]?.draft).toBe(
          savedFile.content,
        );
        expect((await page.read().readData().agentFileOutcome)?.error).toBeUndefined();
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
      let listCalls = 0;
      let writeCalls = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "agents.files.list") {
          listCalls += 1;
          return listCalls === 1 ? list : await rebuild.promise;
        }
        if (method === "agents.files.set") {
          writeCalls += 1;
          if (writeCalls > 1) {
            throw new Error(writeError);
          }
          return {
            ok: true,
            agentId: "main",
            workspace: list.workspace,
            file: { ...list.files[0], content: savedContent },
          };
        }
        if (method === "agents.list") {
          return agentsList;
        }
        if (method === "agents.files.get") {
          return { ...list, file: { ...list.files[0], content: "original" } };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const currentGateway = gateway(snapshot(client));
      const agents = createAgentCapability(currentGateway);
      await agents.ensureFiles("main");
      await agents.ensureList();
      const context = pageContext(currentGateway, agents);
      const page = createAgentsPage(
        context,
        agentsRouteData(currentGateway, agentsList, "main", context.settingsAgentSelection),
      );
      await vi.waitFor(() =>
        expect(page.read().readData().agentFileEditors["AGENTS.md"]?.content).toBe("original"),
      );
      page.read().agentFiles.onFileDraftChange("AGENTS.md", savedContent);
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
          expect(page.read().readData().agentFileSaving).toBe(false);
          expect(page.read().readData().agentFileEditors["AGENTS.md"]?.content).toBe(savedContent);
          expect(listCalls).toBe(2);
        });
        if (newerSaveFails) {
          page.read().agentFiles.onFileDraftChange("AGENTS.md", "newer draft");
          saveDraft();
          expect(await page.read().readData().agentFileOutcome).toEqual({ error: writeError });
        }
        rebuild.reject(new Error(rebuildError));
        await expect(agents.files("main").read).resolves.toEqual({ error: rebuildError });

        mounted.update(page.read());

        await vi.waitFor(() =>
          expect(container.querySelector(".callout.danger")?.textContent).toBe(
            newerSaveFails ? writeError : rebuildError,
          ),
        );
        expect(container.querySelector<HTMLTextAreaElement>(".agent-file-textarea")?.value).toBe(
          newerSaveFails ? "newer draft" : savedContent,
        );
        expect(page.read().readData().agentFileEditors["AGENTS.md"]?.content).toBe(savedContent);
      } finally {
        page.dispose();
        rebuild.resolve(list);
        agents.dispose();
        mounted.dispose();
      }
    },
  );
});
