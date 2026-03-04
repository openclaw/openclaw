"use client";

import { useCallback, useState } from "react";

export interface UPCChallenge {
  challengeId: string;
  toolName: string;
  taskDescription: string;
}

export interface UseUPCVerificationReturn {
  challenge: UPCChallenge | null;
  isOpen: boolean;
  isVerifying: boolean;
  showChallenge: (challenge: UPCChallenge) => void;
  closeChallenge: () => void;
  verifyUPC: (upc: string) => Promise<void>;
  handleToolCall: (toolName: string, taskDescription: string) => Promise<string | null>;
}

type UPCGatewayClient = {
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Hook for managing UPC verification flow in the UI
 * Handles showing the verification modal and submitting the code word
 */
export function useUPCVerification(gatewayClient: UPCGatewayClient): UseUPCVerificationReturn {
  const [challenge, setChallenge] = useState<UPCChallenge | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  const showChallenge = useCallback((newChallenge: UPCChallenge) => {
    setChallenge(newChallenge);
    setIsOpen(true);
  }, []);

  const closeChallenge = useCallback(() => {
    setIsOpen(false);
    setChallenge(null);
  }, []);

  const verifyUPC = useCallback(
    async (upc: string) => {
      if (!challenge) {
        throw new Error("No active challenge");
      }

      setIsVerifying(true);
      try {
        const response = (await gatewayClient.call("upc.verify", {
          upcInput: upc,
          taskName: challenge.toolName,
          taskDescription: challenge.taskDescription,
        })) as { verified?: boolean; error?: string };

        if (!response.verified) {
          throw new Error(response.error || "Verification failed");
        }

        closeChallenge();
      } finally {
        setIsVerifying(false);
      }
    },
    [challenge, gatewayClient, closeChallenge],
  );

  const handleToolCall = useCallback(
    async (toolName: string, taskDescription: string): Promise<string | null> => {
      try {
        const statusResponse = (await gatewayClient.call("upc.status")) as {
          hasUPC?: boolean;
          enabled?: boolean;
        };

        if (!statusResponse.hasUPC || !statusResponse.enabled) {
          return null;
        }

        const challengeResponse = (await gatewayClient.call("upc.approval.create", {
          taskName: toolName,
          taskDescription,
        })) as { id?: string };

        if (!challengeResponse.id || challengeResponse.id === "not-needed") {
          return null;
        }

        showChallenge({
          challengeId: challengeResponse.id,
          toolName,
          taskDescription,
        });

        return challengeResponse.id;
      } catch (err) {
        console.error("Failed to check UPC requirement:", err);
        return null;
      }
    },
    [gatewayClient, showChallenge],
  );

  return {
    challenge,
    isOpen,
    isVerifying,
    showChallenge,
    closeChallenge,
    verifyUPC,
    handleToolCall,
  };
}
