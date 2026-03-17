import { PlayCircle, RotateCcw, Import, Wand2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/hooks/use-gateway";
import { useOnboarding } from "@/hooks/use-onboarding";
import { ONBOARDING_STEPS } from "@/lib/onboarding-utils";
import { useGatewayStore } from "@/store/gateway-store";

type PreCheckMode = "loading" | "fresh" | "resume" | "import" | "wizard";

type ConfigGetResponse = {
  config?: {
    models?: { providers?: Record<string, unknown> };
    env?: Record<string, string>;
  };
  [key: string]: unknown;
};

export function OnboardingPage() {
  const navigate = useNavigate();
  const { state, loading, complete, reset } = useOnboarding();
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const [mode, setMode] = useState<PreCheckMode>("loading");

  // If onboarding is already completed or skipped, redirect to overview
  useEffect(() => {
    if (!loading && state && (state.status === "completed" || state.status === "skipped")) {
      void navigate("/overview", { replace: true });
    }
  }, [loading, state, navigate]);

  // Pre-check: determine mode (fresh, resume, or import)
  const runPreCheck = useCallback(async () => {
    if (!state || loading) {
      return;
    }

    // Resume: if in_progress with step > 1, offer to continue
    if (state.status === "in_progress" && state.currentStep > 1) {
      setMode("resume");
      return;
    }

    // Fresh install: check if system is already configured
    if (state.status === "pending") {
      try {
        const [configRes, agentsRes, channelsRes] = await Promise.all([
          sendRpc<ConfigGetResponse>("config.get", {}).catch(() => null),
          sendRpc<{ agents?: unknown[] }>("agents.list", {}).catch(() => null),
          sendRpc<{ channelOrder?: string[]; channels?: Record<string, { configured?: boolean }> }>(
            "channels.status",
            {},
          ).catch(() => null),
        ]);

        const config = configRes?.config;
        const hasProviders =
          Object.keys(config?.models?.providers ?? {}).length > 0 ||
          Object.keys(config?.env ?? {}).some((k) => /API_KEY$/i.test(k));
        const hasAgents = (agentsRes?.agents?.length ?? 0) > 0;
        const hasChannels = Object.values(channelsRes?.channels ?? {}).some((ch) => ch.configured);

        if (hasProviders && hasAgents && hasChannels) {
          setMode("import");
          return;
        }
      } catch {
        // Detection failed — proceed fresh
      }
    }

    setMode("fresh");
  }, [state, loading, sendRpc]);

  useEffect(() => {
    if (isConnected && !loading && state) {
      void runPreCheck();
    }
  }, [isConnected, loading, state, runPreCheck]);

  // Handle resume: continue from saved step
  const handleResume = useCallback(() => {
    setMode("wizard");
  }, []);

  // Handle start over: reset and start fresh
  const handleStartOver = useCallback(async () => {
    await reset();
    setMode("wizard");
  }, [reset]);

  // Handle import: mark complete and redirect
  const handleImport = useCallback(async () => {
    await complete();
    void navigate("/overview", { replace: true });
  }, [complete, navigate]);

  // Handle run anyway: start wizard despite existing config
  const handleRunAnyway = useCallback(() => {
    setMode("wizard");
  }, []);

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-3">
          <div className="text-lg font-semibold">Connecting to Gateway...</div>
          <p className="text-sm text-muted-foreground">
            Waiting for gateway connection to start setup wizard.
          </p>
        </div>
      </div>
    );
  }

  if (loading || mode === "loading") {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-sm text-muted-foreground">Loading setup wizard...</div>
      </div>
    );
  }

  // Resume dialog
  if (mode === "resume") {
    const stepName =
      ONBOARDING_STEPS[(state?.currentStep ?? 1) - 1]?.title ?? `Step ${state?.currentStep}`;
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="max-w-md text-center space-y-6">
          <Wand2 className="h-12 w-12 mx-auto text-primary" />
          <div>
            <h2 className="text-xl font-semibold">Resume Setup?</h2>
            <p className="text-sm text-muted-foreground mt-2">
              You have an incomplete setup from a previous session. You were on{" "}
              <span className="font-medium text-foreground">{stepName}</span> (step{" "}
              {state?.currentStep} of {ONBOARDING_STEPS.length}).
            </p>
          </div>
          <div className="flex items-center justify-center gap-3">
            <Button variant="outline" onClick={handleStartOver}>
              <RotateCcw className="h-4 w-4 mr-1.5" />
              Start Over
            </Button>
            <Button onClick={handleResume}>
              <PlayCircle className="h-4 w-4 mr-1.5" />
              Continue from {stepName}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Import dialog: system already configured
  if (mode === "import") {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="max-w-md text-center space-y-6">
          <Wand2 className="h-12 w-12 mx-auto text-primary" />
          <div>
            <h2 className="text-xl font-semibold">Already Configured</h2>
            <p className="text-sm text-muted-foreground mt-2">
              Your system already has AI providers, agents, and channels configured. You can import
              the current configuration or run the setup wizard anyway.
            </p>
          </div>
          <div className="flex items-center justify-center gap-3">
            <Button variant="outline" onClick={handleRunAnyway}>
              <Wand2 className="h-4 w-4 mr-1.5" />
              Run Setup Anyway
            </Button>
            <Button onClick={handleImport}>
              <Import className="h-4 w-4 mr-1.5" />
              Import Current Config
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Fresh or wizard mode — render the wizard
  return <OnboardingWizard initialStep={mode === "fresh" ? 1 : (state?.currentStep ?? 1)} />;
}
