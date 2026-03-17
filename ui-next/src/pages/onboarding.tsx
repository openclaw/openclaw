import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { useOnboarding } from "@/hooks/use-onboarding";
import { useGatewayStore } from "@/store/gateway-store";

export function OnboardingPage() {
  const navigate = useNavigate();
  const { state, loading } = useOnboarding();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  // If onboarding is already completed or skipped, redirect to overview
  useEffect(() => {
    if (!loading && state && (state.status === "completed" || state.status === "skipped")) {
      void navigate("/overview", { replace: true });
    }
  }, [loading, state, navigate]);

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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-sm text-muted-foreground">Loading setup wizard...</div>
      </div>
    );
  }

  return <OnboardingWizard initialStep={state?.currentStep ?? 1} />;
}
