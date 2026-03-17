import { useState, useCallback, useEffect } from "react";
import { useGatewayStore } from "@/store/gateway-store";
import { useGateway } from "./use-gateway";

export type OnboardingStatus = "pending" | "in_progress" | "completed" | "skipped";

export type OnboardingState = {
  status: OnboardingStatus;
  currentStep: number;
  stepsCompleted: number[];
  stepsSkipped: number[];
  configSnapshot: Record<string, unknown>;
  startedAt: number | null;
  completedAt: number | null;
};

type ValidatePathResult = {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  writable: boolean;
  valid: boolean;
};

export function useOnboarding() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    if (!isConnected) {
      return;
    }
    try {
      setLoading(true);
      const result = await sendRpc<OnboardingState>("onboarding.status");
      setState(result);
    } catch {
      // Gateway might not support onboarding yet
    } finally {
      setLoading(false);
    }
  }, [sendRpc, isConnected]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const updateStep = useCallback(
    async (params: {
      currentStep?: number;
      stepsCompleted?: number[];
      stepsSkipped?: number[];
      configSnapshot?: Record<string, unknown>;
    }) => {
      const result = await sendRpc<OnboardingState>("onboarding.update", params);
      setState((prev) => (prev ? { ...prev, ...result } : prev));
      return result;
    },
    [sendRpc],
  );

  const complete = useCallback(async () => {
    const result = await sendRpc<{ status: OnboardingStatus; completedAt: number }>(
      "onboarding.complete",
    );
    setState((prev) => (prev ? { ...prev, ...result } : prev));
    return result;
  }, [sendRpc]);

  const skip = useCallback(async () => {
    const result = await sendRpc<{ status: OnboardingStatus; completedAt: number }>(
      "onboarding.skip",
    );
    setState((prev) => (prev ? { ...prev, ...result } : prev));
    return result;
  }, [sendRpc]);

  const reset = useCallback(async () => {
    const result = await sendRpc<OnboardingState>("onboarding.reset");
    setState(result);
    return result;
  }, [sendRpc]);

  const validatePath = useCallback(
    async (pathStr: string) => {
      return sendRpc<ValidatePathResult>("onboarding.validatePath", { path: pathStr });
    },
    [sendRpc],
  );

  return { state, loading, fetchStatus, updateStep, complete, skip, reset, validatePath };
}
