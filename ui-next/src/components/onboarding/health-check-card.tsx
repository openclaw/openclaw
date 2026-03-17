import { CheckCircle2, AlertTriangle, XCircle, Loader2, X } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/hooks/use-gateway";

type CheckItem = {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn";
  detail?: string;
};

type HealthCheckResult = {
  healthy: boolean;
  status: "healthy" | "degraded" | "unhealthy";
  checks: CheckItem[];
};

const STATUS_ICONS = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
} as const;

const STATUS_COLORS = {
  pass: "text-primary",
  warn: "text-yellow-500",
  fail: "text-destructive",
} as const;

export function HealthCheckCard() {
  const { sendRpc } = useGateway();
  const [result, setResult] = useState<HealthCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  // Check if card was dismissed in this browser session
  useEffect(() => {
    const dismissedAt = sessionStorage.getItem("onboarding-health-dismissed");
    if (dismissedAt) {
      setDismissed(true);
    }
  }, []);

  const runCheck = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sendRpc<HealthCheckResult>("onboarding.healthCheck");
      setResult(res);
    } catch {
      // healthCheck not available
    } finally {
      setLoading(false);
    }
  }, [sendRpc]);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    sessionStorage.setItem("onboarding-health-dismissed", String(Date.now()));
  }, []);

  if (dismissed || (!loading && !result)) {
    return null;
  }

  if (loading) {
    return null; // Don't show loading state — card just appears when ready
  }

  if (!result) {
    return null;
  }

  const borderColor =
    result.status === "healthy"
      ? "border-primary/30"
      : result.status === "degraded"
        ? "border-yellow-500/30"
        : "border-destructive/30";

  return (
    <div className={`rounded-lg border ${borderColor} bg-card p-4 space-y-3`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">System Health</h3>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={runCheck}
            disabled={loading}
            className="h-6 px-2 text-xs"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Recheck"}
          </Button>
          <button
            type="button"
            onClick={handleDismiss}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="space-y-1.5">
        {result.checks.map((check) => {
          const Icon = STATUS_ICONS[check.status];
          const color = STATUS_COLORS[check.status];
          return (
            <div key={check.id} className="flex items-center gap-2 text-sm">
              <Icon className={`h-3.5 w-3.5 ${color} shrink-0`} />
              <span className="font-medium">{check.label}</span>
              {check.detail && (
                <span className="text-xs text-muted-foreground ml-auto">{check.detail}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
