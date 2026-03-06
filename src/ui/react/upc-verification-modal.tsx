'use client';

import React, { useState, useCallback } from 'react';

interface UPCVerificationModalProps {
  isOpen: boolean;
  taskDescription: string;
  onVerify: (upc: string) => Promise<void>;
  onCancel: () => void;
}

export const UPCVerificationModal: React.FC<UPCVerificationModalProps> = ({
  isOpen,
  taskDescription,
  onVerify,
  onCancel,
}) => {
  const [upc, setUpc] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptsRemaining, setAttemptsRemaining] = useState(5);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setIsLoading(true);

      try {
        await onVerify(upc);
        setUpc('');
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Verification failed';
        setError(errorMessage);
        setAttemptsRemaining((prev) => Math.max(0, prev - 1));
        setUpc('');
      } finally {
        setIsLoading(false);
      }
    },
    [upc, onVerify]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="mb-2 text-2xl font-bold text-gray-900">Security Verification Required</h2>
        <p className="mb-4 text-gray-600">
          This operation requires additional verification. Please enter your security code word.
        </p>

        <div className="mb-4 rounded-md bg-blue-50 p-4">
          <p className="text-sm text-blue-900">
            <strong>Operation:</strong> {taskDescription}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="upc" className="block text-sm font-medium text-gray-700">
              Security Code Word
            </label>
            <input
              id="upc"
              type="password"
              value={upc}
              onChange={(e) => setUpc(e.target.value)}
              disabled={isLoading || attemptsRemaining === 0}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
              placeholder="Enter your code word"
              autoFocus
            />
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-3">
              <p className="text-sm text-red-800">{error}</p>
              {attemptsRemaining > 0 && (
                <p className="mt-1 text-xs text-red-700">
                  {attemptsRemaining} attempt{attemptsRemaining !== 1 ? 's' : ''} remaining
                </p>
              )}
            </div>
          )}

          {attemptsRemaining === 0 && (
            <div className="rounded-md bg-red-50 p-3">
              <p className="text-sm font-semibold text-red-900">
                Too many attempts. Please try again later.
              </p>
            </div>
          )}

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onCancel}
              disabled={isLoading}
              className="flex-1 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || attemptsRemaining === 0 || !upc.trim()}
              className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Verifying...' : 'Verify'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
