import { Loader2, CheckCircle2, AlertTriangle, XCircle, Wrench } from "lucide-react";
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
import { useAgentHealthStore } from "@/store/agent-dialog-store";
import { useGatewayStore } from "@/store/gateway-store";

interface HealthCheck {
  check: string;
  status: "pass" | "warn" | "fail";
  message?: string;
  fixType?: string;
}

interface HealthResult {
  agentId: string;
  agentName: string;
  tier: number;
  checks: HealthCheck[];
}

const STATUS_ICON = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
} as const;

const STATUS_COLOR = {
  pass: "text-green-500",
  warn: "text-yellow-500",
  fail: "text-red-500",
} as const;

export function AgentHealthDialog({ onFixed }: { onFixed?: () => void }) {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const { open, agentId, closeHealth } = useAgentHealthStore();

  const [result, setResult] = useState<HealthResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [fixingCheck, setFixingCheck] = useState<string | null>(null);
  const [fixResults, setFixResults] = useState<Record<string, "success" | "error">>({});

  const fetchHealth = useCallback(async () => {
    if (!isConnected || !agentId) {
      return;
    }
    setLoading(true);
    setFixResults({});
    try {
      const res = await sendRpc("agents.marketplace.health", {});
      if (res && Array.isArray(res.results)) {
        const match = (res.results as HealthResult[]).find((r) => r.agentId === agentId);
        setResult(match ?? null);
      }
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [isConnected, agentId, sendRpc]);

  useEffect(() => {
    if (open && agentId) {
      void fetchHealth();
    }
    if (!open) {
      setResult(null);
      setFixResults({});
    }
  }, [open, agentId, fetchHealth]);

  const handleFix = useCallback(
    async (check: HealthCheck) => {
      if (!agentId || !check.fixType) {
        return;
      }
      setFixingCheck(check.check);
      try {
        const res = await sendRpc("agents.marketplace.health.fix", {
          agentId,
          fixType: check.fixType,
        });
        if (res?.ok) {
          setFixResults((prev) => ({ ...prev, [check.check]: "success" }));
          onFixed?.();
          // Re-fetch health to update statuses
          await fetchHealth();
        } else {
          setFixResults((prev) => ({ ...prev, [check.check]: "error" }));
        }
      } catch {
        setFixResults((prev) => ({ ...prev, [check.check]: "error" }));
      } finally {
        setFixingCheck(null);
      }
    },
    [agentId, sendRpc, fetchHealth, onFixed],
  );

  const failingChecks = result?.checks.filter((c) => c.status !== "pass") ?? [];
  const passingChecks = result?.checks.filter((c) => c.status === "pass") ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          closeHealth();
        }
      }}
    >
      <DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Health: {result?.agentName ?? agentId}</DialogTitle>
          {result && (
            <DialogDescription>
              T{result.tier} — {result.checks.length} checks, {failingChecks.length} issues
            </DialogDescription>
          )}
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : result ? (
          <div className="flex-1 overflow-auto space-y-3 py-2">
            {/* Failing/warning checks first */}
            {failingChecks.map((check) => {
              const Icon = STATUS_ICON[check.status];
              const fixResult = fixResults[check.check];
              return (
                <div key={check.check} className="flex items-start gap-2 rounded-lg border p-3">
                  <Icon className={cn("size-4 shrink-0 mt-0.5", STATUS_COLOR[check.status])} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{check.check.replace(/_/g, " ")}</div>
                    {check.message && (
                      <p className="text-xs text-muted-foreground mt-0.5">{check.message}</p>
                    )}
                  </div>
                  {check.fixType && !fixResult && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs shrink-0"
                      disabled={fixingCheck === check.check}
                      onClick={() => {
                        void handleFix(check);
                      }}
                    >
                      {fixingCheck === check.check ? (
                        <Loader2 className="size-3 animate-spin mr-1" />
                      ) : (
                        <Wrench className="size-3 mr-1" />
                      )}
                      Fix
                    </Button>
                  )}
                  {fixResult === "success" && (
                    <span className="text-xs text-green-500 flex items-center gap-1">
                      <CheckCircle2 className="size-3" /> Fixed
                    </span>
                  )}
                  {fixResult === "error" && <span className="text-xs text-red-400">Failed</span>}
                </div>
              );
            })}

            {/* Passing checks */}
            {passingChecks.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] font-medium text-muted-foreground uppercase">Passing</p>
                {passingChecks.map((check) => (
                  <div key={check.check} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <CheckCircle2 className="size-3.5 text-green-500" />
                    <span className="text-muted-foreground">{check.check.replace(/_/g, " ")}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No health data available.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeHealth}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
