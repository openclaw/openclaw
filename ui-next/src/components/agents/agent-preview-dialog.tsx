import {
  CheckCircle2,
  Loader2,
  Shield,
  Cpu,
  Zap,
  Clock,
  DollarSign,
  Tag,
  Pencil,
  Download,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useAgentPreviewStore, useAgentConfigStore } from "@/store/agent-dialog-store";
import { useGatewayStore } from "@/store/gateway-store";

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
  routing_hints?: { keywords?: string[]; priority?: string };
  skills?: string[];
  limits?: { timeout_seconds?: number; cost_limit_usd?: number; context_window_tokens?: number };
  author?: { name: string; url?: string };
  promptContent?: string;
}

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

function InfoSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium">
        <Icon className="size-3.5 text-muted-foreground" />
        {title}
      </div>
      {children}
    </div>
  );
}

export function AgentPreviewDialog({ onAction }: { onAction?: () => void }) {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const { open, agentId, closePreview } = useAgentPreviewStore();
  const openConfig = useAgentConfigStore((s) => s.openConfig);

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(false);
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
    if (open && agentId) {
      void fetchAgent();
    }
    if (!open) {
      setAgent(null);
    }
  }, [open, agentId, fetchAgent]);

  const handleInstall = useCallback(async () => {
    if (!agentId) {
      return;
    }
    setInstalling(true);
    try {
      await sendRpc("agents.marketplace.install", { agentId, scope: "project" });
      await fetchAgent();
      onAction?.();
    } catch {
      /* */
    } finally {
      setInstalling(false);
    }
  }, [agentId, sendRpc, fetchAgent, onAction]);

  const handleEdit = useCallback(() => {
    if (!agentId) {
      return;
    }
    closePreview();
    openConfig(agentId);
  }, [agentId, closePreview, openConfig]);

  const isInstalled = agent?.installStatus?.startsWith("installed");

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          closePreview();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {agent ? (
              <>
                {agent.name}
                <TierBadge tier={agent.tier} />
              </>
            ) : (
              "Agent Details"
            )}
          </DialogTitle>
          {agent && (
            <DialogDescription>
              {agent.role} — {agent.department} — v{agent.version}
            </DialogDescription>
          )}
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : agent ? (
          <div className="flex-1 overflow-auto space-y-4 py-2">
            <p className="text-sm">{agent.description}</p>

            {agent.requires && (
              <p className="text-xs text-muted-foreground">
                Requires: <strong>{agent.requires}</strong>
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {agent.capabilities && agent.capabilities.length > 0 && (
                <InfoSection title="Capabilities" icon={Zap}>
                  <div className="flex flex-wrap gap-1">
                    {agent.capabilities.map((c) => (
                      <span
                        key={c}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                      >
                        {c.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                </InfoSection>
              )}
              {agent.model && (
                <InfoSection title="Model" icon={Cpu}>
                  <div className="text-xs space-y-0.5">
                    <p>
                      Primary:{" "}
                      <code className="bg-muted px-1 py-0.5 rounded text-[10px]">
                        {agent.model.primary}
                      </code>
                    </p>
                    <p className="text-muted-foreground">Provider: {agent.model.provider}</p>
                    {agent.model.fallbacks && agent.model.fallbacks.length > 0 && (
                      <p className="text-muted-foreground">
                        Fallbacks: {agent.model.fallbacks.join(", ")}
                      </p>
                    )}
                  </div>
                </InfoSection>
              )}
              {agent.tools && (
                <InfoSection title="Tools" icon={Shield}>
                  <div className="space-y-1">
                    {agent.tools.allow && agent.tools.allow.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {agent.tools.allow.map((t) => (
                          <span
                            key={t}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600"
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
                            className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/10 text-destructive"
                          >
                            deny: {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </InfoSection>
              )}
              {agent.limits && (
                <InfoSection title="Limits" icon={Clock}>
                  <div className="space-y-0.5 text-xs text-muted-foreground">
                    {agent.limits.timeout_seconds && (
                      <div className="flex items-center gap-1">
                        <Clock className="size-2.5" /> Timeout: {agent.limits.timeout_seconds}s
                      </div>
                    )}
                    {agent.limits.cost_limit_usd !== undefined && (
                      <div className="flex items-center gap-1">
                        <DollarSign className="size-2.5" /> Cost: $
                        {agent.limits.cost_limit_usd.toFixed(2)}
                      </div>
                    )}
                  </div>
                </InfoSection>
              )}
              {agent.routing_hints?.keywords && agent.routing_hints.keywords.length > 0 && (
                <InfoSection title="Routing" icon={Tag}>
                  <div className="flex flex-wrap gap-1">
                    {agent.routing_hints.keywords.map((kw) => (
                      <span
                        key={kw}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600"
                      >
                        {kw}
                      </span>
                    ))}
                  </div>
                </InfoSection>
              )}
              {agent.keywords && agent.keywords.length > 0 && (
                <InfoSection title="Keywords" icon={Tag}>
                  <div className="flex flex-wrap gap-1">
                    {agent.keywords.map((kw) => (
                      <span
                        key={kw}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                      >
                        {kw}
                      </span>
                    ))}
                  </div>
                </InfoSection>
              )}
            </div>

            {agent.promptContent && (
              <div className="rounded-lg border p-3 space-y-2">
                <h4 className="text-xs font-medium">AGENT.md</h4>
                <pre className="text-[10px] whitespace-pre-wrap bg-muted p-3 rounded-lg overflow-auto max-h-48 font-mono">
                  {agent.promptContent}
                </pre>
              </div>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground py-8 text-center">Agent not found.</p>
        )}

        <DialogFooter className="sm:justify-between">
          <div className="flex items-center gap-2">
            {agent && isInstalled && (
              <Button size="sm" variant="outline" onClick={handleEdit}>
                <Pencil className="size-3.5 mr-1" />
                Edit Config
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {agent && !isInstalled && (
              <Button
                size="sm"
                onClick={() => {
                  void handleInstall();
                }}
                disabled={installing}
              >
                {installing ? (
                  <Loader2 className="size-3.5 animate-spin mr-1" />
                ) : (
                  <Download className="size-3.5 mr-1" />
                )}
                Install
              </Button>
            )}
            {agent && isInstalled && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircle2 className="size-3.5" /> Installed
              </span>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
