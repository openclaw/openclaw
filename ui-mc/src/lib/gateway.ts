// Gateway WebSocket service
// Reads ?gwHost and ?token from URL params

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface AgentInfo {
  id: string;
  name: string;
  emoji: string;
  model?: string;
  status: "online" | "offline" | "busy" | "unknown";
  role?: string;
}

type EventListener = (data: unknown) => void;

const AGENT_META: Record<string, { name: string; emoji: string; role?: string }> = {
  // Core
  main: { name: "Mavis", emoji: "🦾", role: "Core" },
  "security-1": { name: "Security Audit", emoji: "🔍", role: "Core" },
  "security-2": { name: "API Permissions", emoji: "🔐", role: "Core" },
  "security-3": { name: "Data Privacy", emoji: "🛡️", role: "Core" },
  "trading-research": { name: "Trading Research", emoji: "📈", role: "Core" },
  "trading-bitcoin": { name: "Bitcoin Analyst", emoji: "₿", role: "Core" },
  "content-creator": { name: "Content Creator", emoji: "✍️", role: "Core" },
  "content-poster": { name: "Content Poster", emoji: "📤", role: "Core" },
  "ops-builder": { name: "Ops Builder", emoji: "🛠️", role: "Core" },
  scheduler: { name: "Scheduler", emoji: "📅", role: "Core" },
  "pattern-tracker": { name: "Pattern Tracker", emoji: "🔮", role: "Core" },
  // Engineering
  "frontend-dev": { name: "Frontend Developer", emoji: "🖥️", role: "Engineering" },
  "backend-arch": { name: "Backend Architect", emoji: "⚙️", role: "Engineering" },
  "mobile-dev": { name: "Mobile App Builder", emoji: "📱", role: "Engineering" },
  "ai-engineer": { name: "AI Engineer", emoji: "🤖", role: "Engineering" },
  "devops-auto": { name: "DevOps Automator", emoji: "🚀", role: "Engineering" },
  "rapid-proto": { name: "Rapid Prototyper", emoji: "⚡", role: "Engineering" },
  "senior-dev": { name: "Senior Developer", emoji: "👨‍💻", role: "Engineering" },
  "security-eng": { name: "Security Engineer", emoji: "🔒", role: "Engineering" },
  "technical-writer": { name: "Technical Writer", emoji: "📝", role: "Engineering" },
  "data-engineer": { name: "Data Engineer", emoji: "🗄️", role: "Engineering" },
  "auto-opt-arch": { name: "Autonomous Optimization Architect", emoji: "🎯", role: "Engineering" },
  // Design
  "brand-guard": { name: "Brand Guardian", emoji: "🎨", role: "Design" },
  "image-prompt": { name: "Image Prompt Engineer", emoji: "🖼️", role: "Design" },
  "inclusive-visuals": { name: "Inclusive Visuals Specialist", emoji: "🌈", role: "Design" },
  "ui-designer": { name: "UI Designer", emoji: "🎭", role: "Design" },
  "ux-architect": { name: "UX Architect", emoji: "🏗️", role: "Design" },
  "ux-researcher": { name: "UX Researcher", emoji: "🔬", role: "Design" },
  "visual-story": { name: "Visual Storyteller", emoji: "🎬", role: "Design" },
  "whimsy-inject": { name: "Whimsy Injector", emoji: "✨", role: "Design" },
  // Marketing
  "app-store-opt": { name: "App Store Optimizer", emoji: "📦", role: "Marketing" },
  "growth-hacker": { name: "Growth Hacker", emoji: "📊", role: "Marketing" },
  "instagram-cur": { name: "Instagram Curator", emoji: "📸", role: "Marketing" },
  "reddit-builder": { name: "Reddit Community Builder", emoji: "🧵", role: "Marketing" },
  "social-media": { name: "Social Media Strategist", emoji: "📣", role: "Marketing" },
  "tiktok-strat": { name: "TikTok Strategist", emoji: "🎵", role: "Marketing" },
  "twitter-engager": { name: "Twitter Engager", emoji: "🐦", role: "Marketing" },
  "wechat-mgr": { name: "WeChat Account Manager", emoji: "💬", role: "Marketing" },
  xiaohongshu: { name: "Xiaohongshu Specialist", emoji: "🌸", role: "Marketing" },
  "zhihu-strat": { name: "Zhihu Strategist", emoji: "💡", role: "Marketing" },
  // Product
  "behavioral-nudge": { name: "Behavioral Nudge Engine", emoji: "🧠", role: "Product" },
  "feedback-synth": { name: "Feedback Synthesizer", emoji: "💭", role: "Product" },
  "sprint-prior": { name: "Sprint Prioritizer", emoji: "⚡", role: "Product" },
  "trend-research": { name: "Trend Researcher", emoji: "🔭", role: "Product" },
  // Project Management
  "experiment-track": { name: "Experiment Tracker", emoji: "🧪", role: "Project Management" },
  "project-shep": { name: "Project Shepherd", emoji: "🗂️", role: "Project Management" },
  "studio-ops": { name: "Studio Operations", emoji: "🏢", role: "Project Management" },
  "studio-prod": { name: "Studio Producer", emoji: "🎬", role: "Project Management" },
  "senior-pm": { name: "Senior Project Manager", emoji: "📋", role: "Project Management" },
  // Testing
  "accessibility-audit": { name: "Accessibility Auditor", emoji: "♿", role: "Testing" },
  "api-tester": { name: "API Tester", emoji: "🔌", role: "Testing" },
  "evidence-collect": { name: "Evidence Collector", emoji: "📷", role: "Testing" },
  "perf-benchmark": { name: "Performance Benchmarker", emoji: "⏱️", role: "Testing" },
  "reality-check": { name: "Reality Checker", emoji: "🚨", role: "Testing" },
  "test-analyzer": { name: "Test Results Analyzer", emoji: "📊", role: "Testing" },
  "tool-evaluator": { name: "Tool Evaluator", emoji: "🔧", role: "Testing" },
  "workflow-opt": { name: "Workflow Optimizer", emoji: "⚙️", role: "Testing" },
  // Support
  "analytics-rep": { name: "Analytics Reporter", emoji: "📈", role: "Support" },
  "exec-summary": { name: "Executive Summary Generator", emoji: "📑", role: "Support" },
  "finance-track": { name: "Finance Tracker", emoji: "💰", role: "Support" },
  "infra-maintain": { name: "Infrastructure Maintainer", emoji: "🖥️", role: "Support" },
  "legal-compliance": { name: "Legal Compliance Checker", emoji: "⚖️", role: "Support" },
  "support-respond": { name: "Support Responder", emoji: "🎧", role: "Support" },
  // Spatial Computing
  "macos-spatial": { name: "macOS Spatial/Metal Engineer", emoji: "🍎", role: "Spatial Computing" },
  "terminal-integ": {
    name: "Terminal Integration Specialist",
    emoji: "💻",
    role: "Spatial Computing",
  },
  "visionos-spatial": { name: "visionOS Spatial Engineer", emoji: "👁️", role: "Spatial Computing" },
  "xr-cockpit": {
    name: "XR Cockpit Interaction Specialist",
    emoji: "🎮",
    role: "Spatial Computing",
  },
  "xr-immersive": { name: "XR Immersive Developer", emoji: "🥽", role: "Spatial Computing" },
  "xr-architect": { name: "XR Interface Architect", emoji: "🌐", role: "Spatial Computing" },
  // Specialized
  "agentic-identity": {
    name: "Agentic Identity & Trust Architect",
    emoji: "🔑",
    role: "Specialized",
  },
  "agents-orchestrator": { name: "Agents Orchestrator", emoji: "🎯", role: "Specialized" },
  "data-analytics": { name: "Data Analytics Reporter", emoji: "📊", role: "Specialized" },
  "data-consolidate": { name: "Data Consolidation Agent", emoji: "🗂️", role: "Specialized" },
  "lsp-engineer": { name: "LSP/Index Engineer", emoji: "🔍", role: "Specialized" },
  "report-distribute": { name: "Report Distribution Agent", emoji: "📧", role: "Specialized" },
  "sales-extract": { name: "Sales Data Extraction Agent", emoji: "💼", role: "Specialized" },
  "cultural-intel": { name: "Cultural Intelligence Strategist", emoji: "🌍", role: "Specialized" },
  "developer-advocate": { name: "Developer Advocate", emoji: "🤝", role: "Specialized" },
};

class GatewayService {
  private ws: WebSocket | null = null;
  private gwHost = "127.0.0.1:18789";
  private token = "";
  private reqId = 1;
  private pendingReqs = new Map<string, (result: unknown, error?: unknown) => void>();
  private listeners = new Map<string, Set<EventListener>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  public status: ConnectionStatus = "disconnected";
  public agents: AgentInfo[] = [];
  public onStatusChange?: (s: ConnectionStatus) => void;
  public onAgentsChange?: (a: AgentInfo[]) => void;

  init() {
    const params = new URLSearchParams(window.location.search);
    this.gwHost = params.get("gwHost") || "127.0.0.1:18789";
    this.token = params.get("token") || "";
    this.initAgents();
    this.connect();
  }

  private initAgents() {
    this.agents = Object.entries(AGENT_META).map(([id, meta]) => ({
      id,
      ...meta,
      status: "unknown" as const,
    }));
    this.onAgentsChange?.(this.agents);
  }

  private setStatus(s: ConnectionStatus) {
    this.status = s;
    this.onStatusChange?.(s);
  }

  connect() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.setStatus("connecting");
    const url = `ws://${this.gwHost}`;
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.setStatus("error");
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      // wait for challenge
    };

    this.ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data as string) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    this.ws.onerror = () => {
      this.setStatus("error");
    };

    this.ws.onclose = () => {
      this.connected = false;
      if (this.status !== "error") {
        this.setStatus("disconnected");
      }
      this.markAllAgentsOffline();
      this.scheduleReconnect();
    };
  }

  private handleMessage(msg: Record<string, unknown>) {
    if (msg.type === "event") {
      const event = msg.event as string;
      if (event === "connect.challenge") {
        this.sendConnectRequest();
      }
      // fire named listeners
      this.listeners.get(event)?.forEach((fn) => fn(msg.params));
      this.listeners.get("*")?.forEach((fn) => fn(msg));
    } else if (msg.type === "res") {
      const id = msg.id as string;
      const cb = this.pendingReqs.get(id);
      if (cb) {
        this.pendingReqs.delete(id);
        if (msg.error) {
          cb(null, msg.error);
        } else {
          cb(msg.result, undefined);
        }
      }
    }
  }

  private sendConnectRequest() {
    const id = String(this.reqId++);
    this.send({
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "mavis-mc", name: "Mavis MC", version: "1.0.0" },
        role: "operator",
        auth: { token: this.token },
      },
    });
    this.pendingReqs.set(id, (result, error) => {
      if (error) {
        console.error("[Gateway] connect failed:", error);
        this.setStatus("error");
        return;
      }
      console.log("[Gateway] connected:", result);
      this.connected = true;
      this.setStatus("connected");
      this.fetchAgents();
    });
  }

  private send(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  call(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error("Not connected"));
        return;
      }
      const id = String(this.reqId++);
      this.pendingReqs.set(id, (result, error) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
      this.send({ type: "req", id, method, params: params ?? {} });
    });
  }

  private async fetchAgents() {
    try {
      const result = (await this.call("agents.list")) as {
        agents?: Array<{ id: string; status?: string; model?: string }>;
      } | null;
      const serverAgents = result?.agents ?? [];
      // merge server data with local meta
      const updated = this.agents.map((a) => {
        const srv = serverAgents.find((s) => s.id === a.id);
        if (srv) {
          return {
            ...a,
            status: (srv.status === "online" || srv.status === "busy"
              ? srv.status
              : "offline") as AgentInfo["status"],
            model: srv.model ?? a.model,
          };
        }
        return { ...a, status: "offline" as const };
      });
      // add any new agents from server not in our meta list
      for (const srv of serverAgents) {
        if (!updated.find((a) => a.id === srv.id)) {
          updated.push({
            id: srv.id,
            name: srv.id,
            emoji: "🤖",
            status: (srv.status as AgentInfo["status"]) ?? "unknown",
          });
        }
      }
      this.agents = updated;
      this.onAgentsChange?.(this.agents);
    } catch (err) {
      console.error("[Gateway] agents.list failed:", err);
    }
  }

  private markAllAgentsOffline() {
    this.agents = this.agents.map((a) => ({ ...a, status: "unknown" as const }));
    this.onAgentsChange?.(this.agents);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 4000);
  }

  on(event: string, fn: EventListener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(fn);
  }

  off(event: string, fn: EventListener) {
    this.listeners.get(event)?.delete(fn);
  }
}

export const gateway = new GatewayService();
