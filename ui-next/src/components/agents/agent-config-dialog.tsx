import { Save, Loader2, CheckCircle2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { useGateway } from "@/hooks/use-gateway";
import { useAgentConfigStore } from "@/store/agent-dialog-store";
import { useGatewayStore } from "@/store/gateway-store";

interface AgentDetail {
  id: string;
  name: string;
  tier: number;
  role: string;
  department: string;
  version: string;
  description: string;
  capabilities: string[];
  keywords: string[];
  requires: string | null;
  model: { provider: string; primary: string; fallbacks?: string[] } | null;
  tools: { allow?: string[]; deny?: string[] } | null;
  routing_hints: { keywords?: string[]; priority?: string } | null;
  limits: {
    timeout_seconds?: number;
    cost_limit_usd?: number;
    context_window_tokens?: number;
  } | null;
  skills: string[];
  promptContent: string;
}

export function AgentConfigDialog({ onSaved }: { onSaved?: () => void }) {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const { open, agentId, closeConfig } = useAgentConfigStore();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Form fields
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [keywords, setKeywords] = useState("");
  const [skills, setSkills] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [modelPrimary, setModelPrimary] = useState("");
  const [modelFallbacks, setModelFallbacks] = useState("");
  const [toolsAllow, setToolsAllow] = useState("");
  const [toolsDeny, setToolsDeny] = useState("");
  const [routingKeywords, setRoutingKeywords] = useState("");
  const [routingPriority, setRoutingPriority] = useState("");
  const [limitTimeout, setLimitTimeout] = useState("");
  const [limitCost, setLimitCost] = useState("");
  const [limitTokens, setLimitTokens] = useState("");
  const [promptContent, setPromptContent] = useState("");
  const [agentMeta, setAgentMeta] = useState<{ tier: number; department: string } | null>(null);

  const fetchAgent = useCallback(async () => {
    if (!isConnected || !agentId) {
      return;
    }
    setLoading(true);
    try {
      const res = await sendRpc("agents.marketplace.get", { agentId });
      if (res?.agent) {
        const a = res.agent as AgentDetail;
        setAgentMeta({ tier: a.tier, department: a.department });
        setName(a.name);
        setRole(a.role);
        setDescription(a.description);
        setCapabilities((a.capabilities ?? []).join(", "));
        setKeywords((a.keywords ?? []).join(", "));
        setSkills((a.skills ?? []).join(", "));
        setModelProvider(a.model?.provider ?? "");
        setModelPrimary(a.model?.primary ?? "");
        setModelFallbacks((a.model?.fallbacks ?? []).join(", "));
        setToolsAllow((a.tools?.allow ?? []).join(", "));
        setToolsDeny((a.tools?.deny ?? []).join(", "));
        setRoutingKeywords((a.routing_hints?.keywords ?? []).join(", "));
        setRoutingPriority(a.routing_hints?.priority ?? "normal");
        setLimitTimeout(a.limits?.timeout_seconds?.toString() ?? "");
        setLimitCost(a.limits?.cost_limit_usd?.toString() ?? "");
        setLimitTokens(a.limits?.context_window_tokens?.toString() ?? "");
        setPromptContent(a.promptContent ?? "");
      }
    } catch {
      /* */
    } finally {
      setLoading(false);
    }
  }, [isConnected, agentId, sendRpc]);

  useEffect(() => {
    if (open && agentId) {
      setSaved(false);
      void fetchAgent();
    }
  }, [open, agentId, fetchAgent]);

  const handleSave = useCallback(async () => {
    if (!agentId) {
      return;
    }
    setSaving(true);
    setSaved(false);
    try {
      const splitComma = (s: string) =>
        s
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
      await sendRpc("agents.marketplace.update", {
        agentId,
        name,
        role,
        description,
        capabilities: splitComma(capabilities),
        keywords: splitComma(keywords),
        skills: splitComma(skills),
        model:
          modelProvider || modelPrimary
            ? {
                provider: modelProvider || "anthropic",
                primary: modelPrimary || "claude-sonnet-4-6",
                ...(modelFallbacks ? { fallbacks: splitComma(modelFallbacks) } : {}),
              }
            : undefined,
        tools:
          toolsAllow || toolsDeny
            ? {
                ...(toolsAllow ? { allow: splitComma(toolsAllow) } : {}),
                ...(toolsDeny ? { deny: splitComma(toolsDeny) } : {}),
              }
            : undefined,
        routing_hints:
          routingKeywords || routingPriority
            ? {
                ...(routingKeywords ? { keywords: splitComma(routingKeywords) } : {}),
                ...(routingPriority ? { priority: routingPriority } : {}),
              }
            : undefined,
        limits: {
          ...(limitTimeout ? { timeout_seconds: parseInt(limitTimeout, 10) } : {}),
          ...(limitCost ? { cost_limit_usd: parseFloat(limitCost) } : {}),
          ...(limitTokens ? { context_window_tokens: parseInt(limitTokens, 10) } : {}),
        },
        promptContent,
      });
      setSaved(true);
      onSaved?.();
      setTimeout(() => setSaved(false), 2000);
    } catch {
      /* */
    } finally {
      setSaving(false);
    }
  }, [
    agentId,
    sendRpc,
    name,
    role,
    description,
    capabilities,
    keywords,
    skills,
    modelProvider,
    modelPrimary,
    modelFallbacks,
    toolsAllow,
    toolsDeny,
    routingKeywords,
    routingPriority,
    limitTimeout,
    limitCost,
    limitTokens,
    promptContent,
    onSaved,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          closeConfig();
        }
      }}
    >
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Configure: {name || agentId}</DialogTitle>
          {agentMeta && (
            <DialogDescription>
              T{agentMeta.tier} — {agentMeta.department}
            </DialogDescription>
          )}
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex-1 overflow-auto py-2">
            <div className="grid gap-4 lg:grid-cols-2">
              {/* Identity */}
              <section className="space-y-3 rounded-lg border p-3">
                <h3 className="font-semibold text-xs">Identity</h3>
                <div className="space-y-2">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">Name</label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">Role</label>
                    <Input
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Description
                    </label>
                    <textarea
                      className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm min-h-[60px] resize-y"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </div>
                </div>
              </section>

              {/* Model */}
              <section className="space-y-3 rounded-lg border p-3">
                <h3 className="font-semibold text-xs">Model</h3>
                <div className="space-y-2">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Provider
                    </label>
                    <Input
                      value={modelProvider}
                      onChange={(e) => setModelProvider(e.target.value)}
                      placeholder="anthropic"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Primary Model
                    </label>
                    <Input
                      value={modelPrimary}
                      onChange={(e) => setModelPrimary(e.target.value)}
                      placeholder="claude-opus-4-6"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Fallbacks
                    </label>
                    <Input
                      value={modelFallbacks}
                      onChange={(e) => setModelFallbacks(e.target.value)}
                      placeholder="claude-sonnet-4-6"
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
              </section>

              {/* Tools & Skills */}
              <section className="space-y-3 rounded-lg border p-3">
                <h3 className="font-semibold text-xs">Tools & Skills</h3>
                <div className="space-y-2">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Tools Allow
                    </label>
                    <Input
                      value={toolsAllow}
                      onChange={(e) => setToolsAllow(e.target.value)}
                      placeholder="read, write"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Tools Deny
                    </label>
                    <Input
                      value={toolsDeny}
                      onChange={(e) => setToolsDeny(e.target.value)}
                      placeholder="browser"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">Skills</label>
                    <Input
                      value={skills}
                      onChange={(e) => setSkills(e.target.value)}
                      placeholder="coding-agent"
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
              </section>

              {/* Routing & Capabilities */}
              <section className="space-y-3 rounded-lg border p-3">
                <h3 className="font-semibold text-xs">Routing & Capabilities</h3>
                <div className="space-y-2">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Capabilities
                    </label>
                    <Input
                      value={capabilities}
                      onChange={(e) => setCapabilities(e.target.value)}
                      placeholder="code_review"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Keywords
                    </label>
                    <Input
                      value={keywords}
                      onChange={(e) => setKeywords(e.target.value)}
                      placeholder="backend, api"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Priority
                    </label>
                    <select
                      className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                      value={routingPriority}
                      onChange={(e) => setRoutingPriority(e.target.value)}
                    >
                      <option value="high">High</option>
                      <option value="normal">Normal</option>
                      <option value="low">Low</option>
                    </select>
                  </div>
                </div>
              </section>

              {/* Limits */}
              <section className="space-y-3 rounded-lg border p-3">
                <h3 className="font-semibold text-xs">Limits</h3>
                <div className="space-y-2">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Timeout (sec)
                    </label>
                    <Input
                      type="number"
                      value={limitTimeout}
                      onChange={(e) => setLimitTimeout(e.target.value)}
                      placeholder="300"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Cost Limit ($)
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      value={limitCost}
                      onChange={(e) => setLimitCost(e.target.value)}
                      placeholder="0.50"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground">
                      Context (tokens)
                    </label>
                    <Input
                      type="number"
                      value={limitTokens}
                      onChange={(e) => setLimitTokens(e.target.value)}
                      placeholder="100000"
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
              </section>

              {/* Prompt */}
              <section className="space-y-3 rounded-lg border p-3">
                <h3 className="font-semibold text-xs">AGENT.md Prompt</h3>
                <textarea
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono min-h-[140px] resize-y"
                  value={promptContent}
                  onChange={(e) => setPromptContent(e.target.value)}
                />
              </section>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeConfig}>
            Close
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || loading}>
            {saving ? (
              <Loader2 className="size-3.5 animate-spin mr-1" />
            ) : saved ? (
              <CheckCircle2 className="size-3.5 text-green-500 mr-1" />
            ) : (
              <Save className="size-3.5 mr-1" />
            )}
            {saved ? "Saved" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
