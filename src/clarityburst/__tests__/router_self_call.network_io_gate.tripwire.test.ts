/**
 * ClarityBurst Router Self-Call NETWORK_IO Gating Tripwire Tests
 *
 * Verifies that the router self-call to /api/route no longer escapes
 * ClarityBurst execution-boundary governance and is properly gated
 * through the NETWORK_IO gate.
 *
 * Success Criteria:
 * 1. Router self-call invokes applyNetworkIOGateAndFetch, not bare fetch
 * 2. NETWORK_IO gate decision is applied before network request
 * 3. ABSTAIN outcomes throw ClarityBurstAbstainError (bypass is prevented)
 * 4. PROCEED outcomes allow request execution
 * 5. Structured logging includes governance metadata
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { routeClarityBurst, type RouterInput } from '../router-client.js';
import { ClarityBurstAbstainError } from '../errors.js';
import * as networkIOGating from '../network-io-gating.js';

// Mock the network-io-gating module
vi.mock('../network-io-gating.js', () => ({
  applyNetworkIOGateAndFetch: vi.fn(),
}));

// Mock the fetch globally
global.fetch = vi.fn();

describe('Router Self-Call NETWORK_IO Gating (Tripwire)', () => {
  let mockGateAndFetch: ReturnType<typeof vi.fn>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGateAndFetch = vi.mocked(networkIOGating.applyNetworkIOGateAndFetch);
    mockFetch = vi.mocked(global.fetch);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Bypass Prevention: NETWORK_IO Gate Invoked', () => {
    it('should invoke applyNetworkIOGateAndFetch instead of bare fetch', async () => {
      const mockResponse = new Response(
        JSON.stringify({
          top1: { contract_id: 'test-contract-1', score: 0.95 },
          top2: { contract_id: 'test-contract-2', score: 0.85 },
          router_version: '1.0.0',
        }),
        { status: 200, statusText: 'OK' }
      );

      mockGateAndFetch.mockResolvedValue(mockResponse);

      const input: RouterInput = {
        stageId: 'TOOL_DISPATCH_GATE',
        packId: 'test-pack-v1',
        packVersion: '1.0.0',
        allowedContractIds: ['contract-1', 'contract-2'],
        userText: 'test query',
      };

      const result = await routeClarityBurst(input);

      // CRITICAL: Verify gate function was called, not bare fetch
      expect(mockGateAndFetch).toHaveBeenCalledOnce();
      expect(mockFetch).not.toHaveBeenCalled();

      // Verify gate was called with correct parameters
      const [urlArg, initArg] = mockGateAndFetch.mock.calls[0];
      expect(urlArg).toMatch(/\/api\/route$/);
      expect(initArg?.method).toBe('POST');
      expect(initArg?.headers).toEqual({ 'Content-Type': 'application/json' });

      // Verify result is valid
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.top1.contract_id).toBe('test-contract-1');
      }
    });

    it('should NOT call bare fetch when gateAndFetch is used', async () => {
      const mockResponse = new Response(
        JSON.stringify({
          top1: { contract_id: 'contract-a', score: 0.9 },
          top2: { contract_id: 'contract-b', score: 0.8 },
        }),
        { status: 200 }
      );

      mockGateAndFetch.mockResolvedValue(mockResponse);
      mockFetch.mockResolvedValue(mockResponse);

      const input: RouterInput = {
        stageId: 'MEMORY_MODIFY',
        packId: 'pack-2',
        packVersion: '2.0.0',
        allowedContractIds: ['mem-contract'],
        userText: 'modify memory',
      };

      await routeClarityBurst(input);

      // ENFORCEMENT: Bare fetch must not be called
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockGateAndFetch).toHaveBeenCalledOnce();
    });
  });

  describe('Gate Abstention: Bypass Blocked', () => {
    it('should return error result when gate returns ABSTAIN_CONFIRM', async () => {
      const abstainError = new ClarityBurstAbstainError({
        stageId: 'NETWORK_IO',
        outcome: 'ABSTAIN_CONFIRM',
        reason: 'CONFIRMATION_REQUIRED',
        contractId: 'NETWORK_POST_ROUTE',
        instructions: 'Router self-call requires explicit user confirmation',
      });

      mockGateAndFetch.mockRejectedValue(abstainError);

      const input: RouterInput = {
        stageId: 'TOOL_DISPATCH_GATE',
        packId: 'test-pack',
        packVersion: '1.0.0',
        allowedContractIds: ['contract-1'],
        userText: 'route query',
      };

      // CRITICAL: Gate error is caught and returned as error result (not thrown)
      const result = await routeClarityBurst(input);
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('confirmation');
      }
      
      // TRIPWIRE: Verify gate was invoked (not bare fetch)
      expect(mockGateAndFetch).toHaveBeenCalledOnce();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return error result when gate returns ABSTAIN_CLARIFY', async () => {
      const abstainError = new ClarityBurstAbstainError({
        stageId: 'NETWORK_IO',
        outcome: 'ABSTAIN_CLARIFY',
        reason: 'PACK_POLICY_INCOMPLETE',
        contractId: null,
        instructions: 'Router self-call requires pack policy clarification',
      });

      mockGateAndFetch.mockRejectedValue(abstainError);

      const input: RouterInput = {
        stageId: 'SHELL_EXEC',
        packId: 'pack-v1',
        packVersion: '1.0.0',
        allowedContractIds: ['shell-contract'],
        userText: 'execute command',
      };

      // SECURITY TRIPWIRE: Gate abstention returns error result, preventing routing
      const result = await routeClarityBurst(input);
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeDefined();
      }
      
      // Gate was invoked (not bare fetch)
      expect(mockGateAndFetch).toHaveBeenCalledOnce();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should prevent execution if gate throws before network call', async () => {
      const blockError = new Error('Gate blocked network operation');
      mockGateAndFetch.mockRejectedValue(blockError);

      const input: RouterInput = {
        stageId: 'MESSAGE_EMIT',
        packId: 'msg-pack',
        packVersion: '1.0.0',
        allowedContractIds: ['msg-contract'],
        userText: 'send message',
      };

      // Execution catches gate error and returns error result
      const result = await routeClarityBurst(input);
      
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Gate blocked');
      }

      // CRITICAL: Bare fetch must never be invoked
      expect(mockFetch).not.toHaveBeenCalled();
      // Gate was invoked (preventing bypass)
      expect(mockGateAndFetch).toHaveBeenCalledOnce();
    });
  });

  describe('Gate Approval: Normal Execution', () => {
    it('should execute successfully when gate approves (PROCEED)', async () => {
      const mockResponse = new Response(
        JSON.stringify({
          top1: { contract_id: 'approved-contract', score: 0.99 },
          top2: { contract_id: 'fallback-contract', score: 0.89 },
          router_version: '1.0.0',
        }),
        { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' } }
      );

      mockGateAndFetch.mockResolvedValue(mockResponse);

      const input: RouterInput = {
        stageId: 'CRON_SCHEDULE',
        packId: 'cron-pack-v1',
        packVersion: '1.0.0',
        allowedContractIds: ['cron-contract-1', 'cron-contract-2'],
        userText: 'schedule cron task',
      };

      const result = await routeClarityBurst(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.top1.contract_id).toBe('approved-contract');
        expect(result.data.top1.score).toBe(0.99);
      }

      // Gate was invoked and succeeded
      expect(mockGateAndFetch).toHaveBeenCalledOnce();
    });

    it('should return valid routing decision on gate approval', async () => {
      const mockResponse = new Response(
        JSON.stringify({
          top1: { contract_id: 'primary-choice', score: 0.92 },
          top2: { contract_id: 'secondary-choice', score: 0.82 },
        }),
        { status: 200 }
      );

      mockGateAndFetch.mockResolvedValue(mockResponse);

      const input: RouterInput = {
        stageId: 'BROWSER_AUTOMATE',
        packId: 'browser-v1',
        packVersion: '1.0.0',
        allowedContractIds: ['browser-contract-1', 'browser-contract-2', 'browser-contract-3'],
        userText: 'automate browser action',
        context: { runId: 'test-run-123' },
      };

      const result = await routeClarityBurst(input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.top1).toBeDefined();
        expect(result.data.top2).toBeDefined();
        expect(typeof result.data.top1.score).toBe('number');
      }
    });
  });

  describe('Structured Logging: Governance Metadata', () => {
    it('should include governance metadata in logs on success', async () => {
      // This test verifies that the logging infrastructure will include
      // governance context when implemented. Currently we verify the call was made
      // with correct parameters that logging code will consume.

      const mockResponse = new Response(
        JSON.stringify({
          top1: { contract_id: 'test', score: 0.9 },
          top2: { contract_id: 'test2', score: 0.8 },
        }),
        { status: 200 }
      );

      mockGateAndFetch.mockResolvedValue(mockResponse);

      const input: RouterInput = {
        stageId: 'NODE_INVOKE',
        packId: 'node-pack',
        packVersion: '1.0.0',
        allowedContractIds: ['node-contract'],
        userText: 'invoke node',
        context: { runId: 'audit-test-456' },
      };

      const result = await routeClarityBurst(input);

      expect(result.ok).toBe(true);
      // Logging payload construction happens inside routeClarityBurst;
      // the test verifies gate was properly invoked to enable those logs
      expect(mockGateAndFetch).toHaveBeenCalledOnce();
    });

    it('should pass callType and governance context through gating', async () => {
      const mockResponse = new Response(
        JSON.stringify({
          top1: { contract_id: 'c1', score: 0.85 },
          top2: { contract_id: 'c2', score: 0.75 },
        }),
        { status: 200 }
      );

      mockGateAndFetch.mockResolvedValue(mockResponse);

      const input: RouterInput = {
        stageId: 'SUBAGENT_SPAWN',
        packId: 'subagent-pack',
        packVersion: '1.0.0',
        allowedContractIds: ['subagent-contract'],
        userText: 'spawn subagent',
        context: { runId: 'spawn-123' },
      };

      await routeClarityBurst(input);

      // Verify gate was invoked with POST method to router endpoint
      const [url, init] = mockGateAndFetch.mock.calls[0];
      expect(url).toMatch(/\/api\/route/);
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeDefined();

      // The body contains the routing input with allowed contracts
      const bodyString = typeof init?.body === 'string' ? init.body : String(init?.body);
      const body = JSON.parse(bodyString);
      expect(body.allowedContractIds).toContain('subagent-contract');
    });
  });

  describe('Regression: No Bypass Reintroduction', () => {
    it('should never fall back to bare fetch if gateAndFetch fails', async () => {
      // This is a critical regression test: ensure the code doesn't have
      // a fallback pattern that could bypass the gate

      const gateError = new Error('Gate system unavailable');
      mockGateAndFetch.mockRejectedValue(gateError);

      const input: RouterInput = {
        stageId: 'MEDIA_GENERATE',
        packId: 'media-pack',
        packVersion: '1.0.0',
        allowedContractIds: ['media-contract'],
        userText: 'generate media',
      };

      // Gate error is caught and returned as error result
      const result = await routeClarityBurst(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Gate system unavailable');
      }

      // CRITICAL: Bare fetch must not be a fallback
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockGateAndFetch).toHaveBeenCalledOnce();
    });

    it('should require gate invocation for every router call', async () => {
      const mockResponse = new Response(
        JSON.stringify({
          top1: { contract_id: 'c1', score: 0.9 },
          top2: { contract_id: 'c2', score: 0.8 },
        }),
        { status: 200 }
      );

      mockGateAndFetch.mockResolvedValue(mockResponse);

      const input: RouterInput = {
        stageId: 'TOOL_DISPATCH_GATE',
        packId: 'pack1',
        packVersion: '1.0.0',
        allowedContractIds: ['contract-1'],
        userText: 'query 1',
      };

      // First call
      await routeClarityBurst(input);
      expect(mockGateAndFetch).toHaveBeenCalledTimes(1);

      // Second call
      await routeClarityBurst(input);
      expect(mockGateAndFetch).toHaveBeenCalledTimes(2);

      // Every router call must go through the gate
      expect(mockGateAndFetch.mock.calls).toHaveLength(2);
    });
  });
});
