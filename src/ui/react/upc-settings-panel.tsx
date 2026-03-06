'use client';

import React, { useState, useCallback, useEffect } from 'react';

interface UPCSettingsPanelProps {
  onSave?: (config: UPCConfig) => Promise<void>;
  isLoading?: boolean;
}

export interface UPCConfig {
  enabled: boolean;
  upc?: string;
}

export const UPCSettingsPanel: React.FC<UPCSettingsPanelProps> = ({ onSave, isLoading = false }) => {
  const [enabled, setEnabled] = useState(false);
  const [showSetupForm, setShowSetupForm] = useState(false);
  const [currentUPC, setCurrentUPC] = useState('');
  const [newUPC, setNewUPC] = useState('');
  const [confirmUPC, setConfirmUPC] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [step, setStep] = useState<'view' | 'change'>('view');

  const handleEnableToggle = useCallback(async () => {
    if (!enabled && !currentUPC) {
      setShowSetupForm(true);
      setStep('view');
      return;
    }

    try {
      await onSave?.({
        enabled: !enabled,
        upc: currentUPC,
      });
      setEnabled(!enabled);
      setMessage({
        type: 'success',
        text: `UPC ${!enabled ? 'enabled' : 'disabled'} successfully`,
      });
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update UPC settings',
      });
    }
  }, [enabled, currentUPC, onSave]);

  const handleSetUPC = useCallback(async () => {
    if (!newUPC || !confirmUPC) {
      setMessage({ type: 'error', text: 'Please fill in all fields' });
      return;
    }

    if (newUPC !== confirmUPC) {
      setMessage({ type: 'error', text: 'Code words do not match' });
      return;
    }

    if (newUPC.length < 4) {
      setMessage({ type: 'error', text: 'Code word must be at least 4 characters' });
      return;
    }

    try {
      await onSave?.({
        enabled: true,
        upc: newUPC,
      });
      setCurrentUPC(newUPC);
      setNewUPC('');
      setConfirmUPC('');
      setShowSetupForm(false);
      setEnabled(true);
      setMessage({
        type: 'success',
        text: 'Security code word set successfully',
      });
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to set code word',
      });
    }
  }, [newUPC, confirmUPC, onSave]);

  const handleChangeUPC = useCallback(async () => {
    if (!currentUPC || !newUPC || !confirmUPC) {
      setMessage({ type: 'error', text: 'Please fill in all fields' });
      return;
    }

    if (newUPC !== confirmUPC) {
      setMessage({ type: 'error', text: 'New code words do not match' });
      return;
    }

    if (newUPC.length < 4) {
      setMessage({ type: 'error', text: 'Code word must be at least 4 characters' });
      return;
    }

    try {
      await onSave?.({
        enabled,
        upc: newUPC,
      });
      setCurrentUPC(newUPC);
      setNewUPC('');
      setConfirmUPC('');
      setStep('view');
      setMessage({
        type: 'success',
        text: 'Security code word updated successfully',
      });
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update code word',
      });
    }
  }, [currentUPC, newUPC, confirmUPC, enabled, onSave]);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Private UPC Security</h3>
          <p className="mt-1 text-sm text-gray-600">
            Add an extra layer of protection to sensitive operations by requiring a security code
            word.
          </p>
        </div>

        {/* Enable/Disable Toggle */}
        <div className="flex items-center justify-between rounded-md bg-gray-50 p-4">
          <div>
            <p className="font-medium text-gray-900">Protection Status</p>
            <p className="text-sm text-gray-600">
              {enabled ? 'UPC protection is enabled' : 'UPC protection is disabled'}
            </p>
          </div>
          <button
            onClick={handleEnableToggle}
            disabled={isLoading}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              enabled ? 'bg-green-600' : 'bg-gray-300'
            } disabled:opacity-50`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Messages */}
        {message && (
          <div
            className={`rounded-md p-3 ${
              message.type === 'success'
                ? 'bg-green-50 text-green-800'
                : 'bg-red-50 text-red-800'
            }`}
          >
            <p className="text-sm">{message.text}</p>
          </div>
        )}

        {/* Setup/Change Form */}
        {showSetupForm && (
          <div className="space-y-4 rounded-md bg-blue-50 p-4">
            {step === 'view' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    New Security Code Word
                  </label>
                  <input
                    type="password"
                    value={newUPC}
                    onChange={(e) => setNewUPC(e.target.value)}
                    disabled={isLoading}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100"
                    placeholder="Choose a strong code word"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Confirm Code Word
                  </label>
                  <input
                    type="password"
                    value={confirmUPC}
                    onChange={(e) => setConfirmUPC(e.target.value)}
                    disabled={isLoading}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100"
                    placeholder="Confirm your code word"
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => {
                      setShowSetupForm(false);
                      setNewUPC('');
                      setConfirmUPC('');
                    }}
                    disabled={isLoading}
                    className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:bg-gray-100"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSetUPC}
                    disabled={isLoading || !newUPC || !confirmUPC}
                    className="flex-1 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
                  >
                    Set Code Word
                  </button>
                </div>
              </>
            )}

            {step === 'change' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Current Code Word
                  </label>
                  <input
                    type="password"
                    value={currentUPC}
                    onChange={(e) => setCurrentUPC(e.target.value)}
                    disabled={isLoading}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100"
                    placeholder="Enter current code word"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    New Code Word
                  </label>
                  <input
                    type="password"
                    value={newUPC}
                    onChange={(e) => setNewUPC(e.target.value)}
                    disabled={isLoading}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100"
                    placeholder="Choose new code word"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Confirm New Code Word
                  </label>
                  <input
                    type="password"
                    value={confirmUPC}
                    onChange={(e) => setConfirmUPC(e.target.value)}
                    disabled={isLoading}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100"
                    placeholder="Confirm new code word"
                  />
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => {
                      setStep('view');
                      setNewUPC('');
                      setConfirmUPC('');
                    }}
                    disabled={isLoading}
                    className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:bg-gray-100"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleChangeUPC}
                    disabled={isLoading || !newUPC || !confirmUPC || !currentUPC}
                    className="flex-1 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
                  >
                    Update Code Word
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Change Code Word Button */}
        {enabled && currentUPC && !showSetupForm && (
          <button
            onClick={() => {
              setShowSetupForm(true);
              setStep('change');
            }}
            disabled={isLoading}
            className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:bg-gray-100"
          >
            Change Code Word
          </button>
        )}

        {/* Info Box */}
        <div className="rounded-md bg-gray-100 p-4">
          <h4 className="font-medium text-gray-900">Security Tips</h4>
          <ul className="mt-2 space-y-1 text-sm text-gray-700">
            <li>• Use a unique code word that you'll remember</li>
            <li>• Don't share your code word with anyone</li>
            <li>• After 5 failed attempts, you'll be locked out for 15 minutes</li>
            <li>• This protects sensitive operations like system restarts and configuration changes</li>
          </ul>
        </div>
      </div>
    </div>
  );
};
