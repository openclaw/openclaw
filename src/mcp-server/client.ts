/**
 * OpenClaw Gateway Client
 *
 * HTTP client for communicating with the OpenClaw gateway.
 */

export interface ClientOptions {
	baseUrl: string;
	agentId: string;
}

export interface SendMessageOptions {
	message: string;
	sessionKey?: string;
	thinking?: "off" | "low" | "medium" | "high";
}

export interface MemorySearchOptions {
	query: string;
	limit?: number;
	mode?: "search" | "vsearch" | "query";
}

export interface SessionInfo {
	sessionKey: string;
	agentId: string;
	channel: string;
	threadId?: string;
	createdAt: string;
}

export interface MemoryEntry {
	id: string;
	content: string;
	score?: number;
	metadata?: Record<string, unknown>;
}

export interface AgentStatus {
	agentId: string;
	status: "idle" | "running" | "error";
	currentSession?: string;
	workspace: string;
}

export class OpenClawClient {
	private baseUrl: string;
	private agentId: string;

	constructor(options: ClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.agentId = options.agentId;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const response = await fetch(url, {
			method,
			headers: {
				"Content-Type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`HTTP ${response.status}: ${text}`);
		}

		return response.json() as Promise<T>;
	}

	/**
	 * Send a message to the agent and get a response
	 */
	async sendMessage(options: SendMessageOptions): Promise<string> {
		const result = await this.request<{ response: string }>("POST", "/api/message", {
			agentId: this.agentId,
			message: options.message,
			sessionKey: options.sessionKey,
			thinking: options.thinking ?? "low",
		});
		return result.response;
	}

	/**
	 * Search agent memory/knowledge base
	 */
	async searchMemory(options: MemorySearchOptions): Promise<MemoryEntry[]> {
		const result = await this.request<{ results: MemoryEntry[] }>(
			"POST",
			"/api/memory/search",
			{
				agentId: this.agentId,
				query: options.query,
				limit: options.limit ?? 10,
				mode: options.mode ?? "search",
			},
		);
		return result.results;
	}

	/**
	 * Add an entry to agent memory
	 */
	async addMemory(content: string, metadata?: Record<string, unknown>): Promise<string> {
		const result = await this.request<{ id: string }>("POST", "/api/memory/add", {
			agentId: this.agentId,
			content,
			metadata,
		});
		return result.id;
	}

	/**
	 * Get agent status
	 */
	async getStatus(): Promise<AgentStatus> {
		return this.request<AgentStatus>("GET", `/api/agents/${this.agentId}/status`);
	}

	/**
	 * List active sessions
	 */
	async listSessions(): Promise<SessionInfo[]> {
		const result = await this.request<{ sessions: SessionInfo[] }>(
			"GET",
			`/api/agents/${this.agentId}/sessions`,
		);
		return result.sessions;
	}

	/**
	 * Get session transcript
	 */
	async getSessionTranscript(sessionKey: string): Promise<unknown[]> {
		const result = await this.request<{ messages: unknown[] }>(
			"GET",
			`/api/agents/${this.agentId}/sessions/${sessionKey}`,
		);
		return result.messages;
	}

	/**
	 * Execute a skill
	 */
	async executeSkill(skillName: string, args?: string): Promise<string> {
		const result = await this.request<{ output: string }>("POST", "/api/skill", {
			agentId: this.agentId,
			skill: skillName,
			args,
		});
		return result.output;
	}

	/**
	 * Read a file from agent workspace
	 */
	async readFile(path: string): Promise<string> {
		const result = await this.request<{ content: string }>("POST", "/api/workspace/read", {
			agentId: this.agentId,
			path,
		});
		return result.content;
	}

	/**
	 * List files in agent workspace
	 */
	async listFiles(path?: string): Promise<string[]> {
		const result = await this.request<{ files: string[] }>("POST", "/api/workspace/list", {
			agentId: this.agentId,
			path: path ?? ".",
		});
		return result.files;
	}
}
