import {
  ArrowLeft,
  Download,
  CheckCircle2,
  Loader2,
  Shield,
  Cpu,
  Zap,
  Clock,
  DollarSign,
  Tag,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentDetail {
  id: string;
  name: string;
  tier: number;
  role: string;
  department: string;
  description: string;
  version: string;
  capabilities: string[];
  keywords: string[];
  category: string;
  installStatus: string;
  requires?: string | null;
  model?: { provider: string; primary: string; fallbacks?: string[] };
  tools?: { allow?: string[]; deny?: string[] };
  routing_hints?: { keywords?: string[]; priority?: string; preferred_for?: string[] };
  skills?: string[];
  limits?: {
    timeout_seconds?: number;
    cost_limit_usd?: number;
    context_window_tokens?: number;
  };
  author?: { name: string; url?: string };
  promptContent?: string;
}

// ── Badges ───────────────────────────────────────────────────────────────────

function TierBadge({ tier }: { tier: number }) {
  const label = tier === 1 ? "Core" : tier === 2 ? "Dept Head" : "Specialist";
  const color =
    tier === 1
      ? "bg-amber-500/10 text-amber-600 border-amber-500/20"
      : tier === 2
        ? "bg-blue-500/10 text-blue-600 border-blue-500/20"
        : "bg-zinc-500/10 text-zinc-600 border-zinc-500/20";
  return (
    <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full border", color)}>
      T{tier} {label}
    </span>
  );
}

// ── Section helper ───────────────────────────────────────────────────────────

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" />
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function AgentPreviewPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const navigate = useNavigate();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  const fetchAgent = useCallback(async () => {
    if (!isConnected || !agentId) {
      return;
    }
    setLoading(true);
    try {
      const res = await sendRpc("agents.marketplace.get", { agentId });
      if (res?.agent) {
        setAgent(res.agent as AgentDetail);
      }
    } catch {
      setAgent(null);
    } finally {
      setLoading(false);
    }
  }, [isConnected, agentId, sendRpc]);

  useEffect(() => {
    void fetchAgent();
  }, [fetchAgent]);

  const handleInstall = useCallback(async () => {
    if (!agentId) {
      return;
    }
    setInstalling(true);
    try {
      await sendRpc("agents.marketplace.install", { agentId, scope: "project" });
      await fetchAgent();
    } catch {
      // not available
    } finally {
      setInstalling(false);
    }
  }, [agentId, sendRpc, fetchAgent]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-4 mr-1" /> Back
        </Button>
        <p className="text-muted-foreground">Agent not found.</p>
      </div>
    );
  }

  const isInstalled = agent.installStatus?.startsWith("installed");

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="-ml-2">
            <ArrowLeft className="size-4 mr-1" /> Back to Browse
          </Button>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold tracking-tight">{agent.name}</h2>
            <TierBadge tier={agent.tier} />
          </div>
          <p className="text-muted-foreground">
            {agent.role} — {agent.department}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isInstalled ? (
            <span className="flex items-center gap-1 text-sm text-green-600 font-medium">
              <CheckCircle2 className="size-4" /> Installed
            </span>
          ) : (
            <Button
              onClick={() => {
                void handleInstall();
              }}
              disabled={installing}
            >
              {installing ? (
                <Loader2 className="size-4 animate-spin mr-1" />
              ) : (
                <Download className="size-4 mr-1" />
              )}
              Install
            </Button>
          )}
        </div>
      </div>

      {/* Description */}
      <p className="text-sm">{agent.description}</p>

      {/* Metadata row */}
      <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
        <span>v{agent.version}</span>
        {agent.requires && (
          <span>
            Requires: <strong>{agent.requires}</strong>
          </span>
        )}
        {agent.author && (
          <span>
            By{" "}
            {agent.author.url ? (
              <a href={agent.author.url} className="underline" target="_blank" rel="noreferrer">
                {agent.author.name}
              </a>
            ) : (
              agent.author.name
            )}
          </span>
        )}
      </div>

      {/* Detail grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Capabilities */}
        {agent.capabilities && agent.capabilities.length > 0 && (
          <Section title="Capabilities" icon={Zap}>
            <div className="flex flex-wrap gap-1.5">
              {agent.capabilities.map((cap) => (
                <span
                  key={cap}
                  className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground"
                >
                  {cap.replace(/_/g, " ")}
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* Routing hints */}
        {agent.routing_hints?.keywords && agent.routing_hints.keywords.length > 0 && (
          <Section title="Routing Keywords" icon={Tag}>
            <div className="flex flex-wrap gap-1.5">
              {agent.routing_hints.keywords.map((kw) => (
                <span key={kw} className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-600">
                  {kw}
                </span>
              ))}
            </div>
            {agent.routing_hints.priority && (
              <p className="text-xs text-muted-foreground">
                Priority: {agent.routing_hints.priority}
              </p>
            )}
          </Section>
        )}

        {/* Model */}
        {agent.model && (
          <Section title="Model" icon={Cpu}>
            <div className="space-y-1 text-sm">
              <p>
                Primary:{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">{agent.model.primary}</code>
              </p>
              <p className="text-xs text-muted-foreground">Provider: {agent.model.provider}</p>
              {agent.model.fallbacks && agent.model.fallbacks.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Fallbacks: {agent.model.fallbacks.join(", ")}
                </p>
              )}
            </div>
          </Section>
        )}

        {/* Tools */}
        {agent.tools && (
          <Section title="Tools" icon={Shield}>
            <div className="space-y-1 text-sm">
              {agent.tools.allow && agent.tools.allow.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {agent.tools.allow.map((t) => (
                    <span
                      key={t}
                      className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-600"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {agent.tools.deny && agent.tools.deny.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {agent.tools.deny.map((t) => (
                    <span
                      key={t}
                      className="text-xs px-1.5 py-0.5 rounded bg-destructive/10 text-destructive"
                    >
                      deny: {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Limits */}
        {agent.limits && (
          <Section title="Limits" icon={Clock}>
            <div className="space-y-1 text-sm text-muted-foreground">
              {agent.limits.timeout_seconds && (
                <div className="flex items-center gap-1.5">
                  <Clock className="size-3" /> Timeout: {agent.limits.timeout_seconds}s
                </div>
              )}
              {agent.limits.cost_limit_usd !== undefined && (
                <div className="flex items-center gap-1.5">
                  <DollarSign className="size-3" /> Cost limit: $
                  {agent.limits.cost_limit_usd.toFixed(2)}
                </div>
              )}
              {agent.limits.context_window_tokens && (
                <div className="flex items-center gap-1.5">
                  <Cpu className="size-3" /> Context:{" "}
                  {(agent.limits.context_window_tokens / 1000).toFixed(0)}k tokens
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Skills */}
        {agent.skills && agent.skills.length > 0 && (
          <Section title="Skills" icon={Zap}>
            <div className="flex flex-wrap gap-1.5">
              {agent.skills.map((skill) => (
                <span
                  key={skill}
                  className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground"
                >
                  {skill}
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* Keywords */}
        {agent.keywords && agent.keywords.length > 0 && (
          <Section title="Keywords" icon={Tag}>
            <div className="flex flex-wrap gap-1.5">
              {agent.keywords.map((kw) => (
                <span key={kw} className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground">
                  {kw}
                </span>
              ))}
            </div>
          </Section>
        )}
      </div>

      {/* AGENT.md content */}
      {agent.promptContent && (
        <div className="rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-medium">Agent Instructions (AGENT.md)</h3>
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <pre className="text-xs whitespace-pre-wrap bg-muted p-4 rounded-lg overflow-auto max-h-96">
              {agent.promptContent}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
