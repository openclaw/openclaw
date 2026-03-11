import type { HarnessAgentConfig, ManagedIssueSummary } from "./types.js";

type RequestInitLike = {
  method?: string;
  body?: unknown;
};

type PaperclipCompany = {
  id: string;
  name: string;
  issuePrefix: string;
};

type PaperclipProject = {
  id: string;
  name: string;
  primaryWorkspace: { id: string; cwd: string | null } | null;
};

type PaperclipAgent = {
  id: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
  companyId?: string;
};

export class PaperclipClient {
  constructor(private readonly apiBase: string) {}

  private async request<T>(pathname: string, init: RequestInitLike = {}) {
    const response = await fetch(new URL(pathname, this.apiBase), {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    const json =
      text.length > 0
        ? (JSON.parse(text) as T | { error?: string; details?: unknown })
        : (null as T | null);
    if (!response.ok) {
      const message =
        typeof json === "object" && json && "error" in json && typeof json.error === "string"
          ? json.error
          : response.statusText;
      const details =
        typeof json === "object" && json && "details" in json && json.details !== undefined
          ? ` ${JSON.stringify(json.details)}`
          : "";
      throw new Error(`Paperclip API request failed: ${message}${details}`);
    }
    return json as T;
  }

  listCompanies() {
    return this.request<PaperclipCompany[]>("/api/companies");
  }

  createCompany(input: { name: string; description?: string | null }) {
    return this.request<PaperclipCompany>("/api/companies", {
      method: "POST",
      body: input,
    });
  }

  listProjects(companyId: string) {
    return this.request<PaperclipProject[]>(`/api/companies/${companyId}/projects`);
  }

  createProject(input: {
    companyId: string;
    name: string;
    description?: string | null;
    repoCwd: string;
    repoUrl?: string;
    repoRef?: string;
  }) {
    return this.request<PaperclipProject>(`/api/companies/${input.companyId}/projects`, {
      method: "POST",
      body: {
        name: input.name,
        description: input.description ?? null,
        status: "planned",
        workspace: {
          name: input.name,
          cwd: input.repoCwd,
          repoUrl: input.repoUrl ?? null,
          repoRef: input.repoRef ?? null,
          isPrimary: true,
        },
      },
    });
  }

  listAgents(companyId: string) {
    return this.request<PaperclipAgent[]>(`/api/companies/${companyId}/agents`);
  }

  createAgent(input: {
    companyId: string;
    config: HarnessAgentConfig;
    cwd: string;
    promptTemplate: string;
  }) {
    return this.request<PaperclipAgent>(`/api/companies/${input.companyId}/agents`, {
      method: "POST",
      body: {
        name: input.config.name,
        title: input.config.title,
        role: "general",
        capabilities: input.config.capabilities ?? null,
        adapterType: "codex_local",
        adapterConfig: {
          cwd: input.cwd,
          instructionsFilePath: input.config.instructionsFile,
          model: input.config.model,
          promptTemplate: input.promptTemplate,
          search: input.config.search ?? false,
          dangerouslyBypassApprovalsAndSandbox:
            input.config.dangerouslyBypassApprovalsAndSandbox ?? true,
        },
      },
    });
  }

  updateAgent(
    agentId: string,
    input: {
      config: HarnessAgentConfig;
      cwd: string;
      promptTemplate: string;
    },
  ) {
    return this.request<PaperclipAgent>(`/api/agents/${agentId}`, {
      method: "PATCH",
      body: {
        name: input.config.name,
        title: input.config.title,
        capabilities: input.config.capabilities ?? null,
        adapterType: "codex_local",
        adapterConfig: {
          cwd: input.cwd,
          instructionsFilePath: input.config.instructionsFile,
          model: input.config.model,
          promptTemplate: input.promptTemplate,
          search: input.config.search ?? false,
          dangerouslyBypassApprovalsAndSandbox:
            input.config.dangerouslyBypassApprovalsAndSandbox ?? true,
        },
      },
    });
  }

  listIssues(companyId: string, filters: Record<string, string | undefined> = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) {
        query.set(key, value);
      }
    }
    const suffix = query.toString();
    return this.request<ManagedIssueSummary[]>(
      `/api/companies/${companyId}/issues${suffix ? `?${suffix}` : ""}`,
    );
  }

  getIssue(issueId: string) {
    return this.request<ManagedIssueSummary>(`/api/issues/${issueId}`);
  }

  listComments(issueId: string) {
    return this.request<Array<{ id: string; body: string; createdAt: string }>>(
      `/api/issues/${issueId}/comments`,
    );
  }

  createIssue(companyId: string, body: Record<string, unknown>) {
    return this.request<ManagedIssueSummary>(`/api/companies/${companyId}/issues`, {
      method: "POST",
      body,
    });
  }

  updateIssue(issueId: string, body: Record<string, unknown>) {
    return this.request<ManagedIssueSummary>(`/api/issues/${issueId}`, {
      method: "PATCH",
      body,
    });
  }

  addComment(issueId: string, body: string) {
    return this.request(`/api/issues/${issueId}/comments`, {
      method: "POST",
      body: { body },
    });
  }

  wakeAgent(agentId: string, issueId: string, reason: string) {
    return this.request(`/api/agents/${agentId}/wakeup`, {
      method: "POST",
      body: {
        source: "on_demand",
        triggerDetail: "manual",
        reason,
        payload: { issueId },
      },
    });
  }

  pauseAgent(agentId: string) {
    return this.request(`/api/agents/${agentId}/pause`, { method: "POST" });
  }

  resumeAgent(agentId: string) {
    return this.request(`/api/agents/${agentId}/resume`, { method: "POST" });
  }

  terminateAgent(agentId: string) {
    return this.request(`/api/agents/${agentId}/terminate`, { method: "POST" });
  }

  listLiveRuns(companyId: string) {
    return this.request<Array<{ id: string; agentId: string; issueId: string | null }>>(
      `/api/companies/${companyId}/live-runs`,
    );
  }

  cancelRun(runId: string) {
    return this.request(`/api/heartbeat-runs/${runId}/cancel`, { method: "POST" });
  }
}
