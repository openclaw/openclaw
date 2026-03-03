'use client';

import { useState, useCallback } from 'react';

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

/**
 * Hook for managing UPC verification flow in the UI
 * Handles showing the verification modal and submitting the code word
 */
export function useUPCVerification(
  gatewayClient: any // Replace with actual gateway client type
): UseUPCVerificationReturn {
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
      if (!challenge) throw new Error('No active challenge');

      setIsVerifying(true);
      try {
        const response = await gatewayClient.call('security.upc.verify', {
          challengeId: challenge.challengeId,
          credential: upc,
        });

        if (!response.verified) {
          throw new Error(response.message || 'Verification failed');
        }

        closeChallenge();
      } finally {
        setIsVerifying(false);
      }
    },
    [challenge, gatewayClient, closeChallenge]
  );

  const handleToolCall = useCallback(
    async (toolName: string, taskDescription: string): Promise<string | null> => {
      try {
        // Check if tool requires UPC verification
        const statusResponse = await gatewayClient.call('security.upc.getStatus');

        if (!statusResponse.hasUPC || !statusResponse.enabled) {
          // No UPC set up, allow the call
          return null;
        }

        // Request a verification challenge
        const challengeResponse = await gatewayClient.call(
          'security.upc.requestChallenge',
          {
            toolName,
            taskDescription,
          }
        );

        if (challengeResponse.requiresVerification) {
          // Show the verification modal and wait for response
          showChallenge({
            challengeId: challengeResponse.challengeId,
            toolName,
            taskDescription,
          });

          // Return the challenge ID so the caller knows verification is pending
          return challengeResponse.challengeId;
        }

        return null;
      } catch (err) {
        console.error('Failed to check UPC requirement:', err);
        return null;
      }
    },
    [gatewayClient, showChallenge]
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
