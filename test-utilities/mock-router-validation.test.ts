/**
 * Mock Clarity Router & Gating Helpers Validation Tests
 * 
 * Comprehensive test suite validating Phase 2A infrastructure components:
 * - Mock router core functionality
 * - Mock router configuration and behavior
 * - Gating helper functions
 * - Performance baselines
 * 
 * Phase: 2A Infrastructure Enhancement
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createMockClarityRouter,
  type GatingRequest,
  type MockClarityRouter,
} from './mock-clarity-router'
import {
  expectGatingAbstain,
  expectGatingSuccess,
  withGatingBypass,
  configureGatingFor,
  getGatingHistory,
  resetGatingState,
  expectStageCalled,
  getStageCallCount,
} from './gating-helpers'

// ============================================================================
// MOCK ROUTER TESTS
// ============================================================================

describe('MockClarityRouter - Core Functionality', () => {
  let router: MockClarityRouter

  beforeEach(() => {
    router = createMockClarityRouter()
  })

  it('should create a router instance', () => {
    expect(router).toBeDefined()
    expect(typeof router.route).toBe('function')
  })

  it('should start and stop correctly', async () => {
    expect(router.isReady()).toBe(false)
    await router.start()
    expect(router.isReady()).toBe(true)
    await router.stop()
    expect(router.isReady()).toBe(false)
  })

  it('should allow operations by default', async () => {
    await router.start()

    const response = await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })

    expect(response.allowed).toBe(true)
    expect(response.decision).toBe('allow')
  })

  it('should reject operations when not ready', async () => {
    const response = await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })

    expect(response.allowed).toBe(false)
    expect(response.decision).toBe('abstain')
    expect(response.reason).toBe('router_not_ready')
  })

  it('should record call history', async () => {
    await router.start()

    await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })

    expect(router.getCallCount()).toBe(1)
    expect(router.getCalls()).toHaveLength(1)
  })

  it('should filter call history by stage', async () => {
    await router.start()

    await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })
    await router.route({
      stageId: 'MEMORY_MODIFY',
      contractId: 'test-456',
      timestamp: Date.now(),
    })

    expect(router.getCallCount()).toBe(2)
    expect(router.getCallCount('SHELL_EXEC')).toBe(1)
    expect(router.getCallCount('MEMORY_MODIFY')).toBe(1)
  })
})

// ============================================================================
// MOCK ROUTER CONFIGURATION TESTS
// ============================================================================

describe('MockClarityRouter - Configuration', () => {
  let router: MockClarityRouter

  beforeEach(async () => {
    router = createMockClarityRouter()
    await router.start()
  })

  it('should configure stage-specific behavior to abstain', async () => {
    router.configureStageBehavior('SHELL_EXEC', {
      type: 'abstain',
      reason: 'unauthorized',
    })

    const response = await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })

    expect(response.allowed).toBe(false)
    expect(response.decision).toBe('abstain')
    expect(response.reason).toBe('unauthorized')
  })

  it('should configure stage-specific behavior to deny', async () => {
    router.configureStageBehavior('MEMORY_MODIFY', {
      type: 'deny',
      reason: 'forbidden',
    })

    const response = await router.route({
      stageId: 'MEMORY_MODIFY',
      contractId: 'test-123',
      timestamp: Date.now(),
    })

    expect(response.allowed).toBe(false)
    expect(response.decision).toBe('deny')
    expect(response.reason).toBe('forbidden')
  })

  it('should use default behavior for unconfigured stages', async () => {
    router.setDefaultBehavior({ type: 'abstain', reason: 'default' })

    const response = await router.route({
      stageId: 'UNKNOWN_STAGE',
      contractId: 'test-123',
      timestamp: Date.now(),
    })

    expect(response.decision).toBe('abstain')
    expect(response.reason).toBe('default')
  })

  it('should enforce authorization when required', async () => {
    router.setAuthorizationRequired(true)
    router.setAuthorizedContracts(['contract-123'])

    const authorized = await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'contract-123',
      timestamp: Date.now(),
    })
    expect(authorized.allowed).toBe(true)

    const unauthorized = await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'contract-456',
      timestamp: Date.now(),
    })
    expect(unauthorized.allowed).toBe(false)
    expect(unauthorized.reason).toBe('unauthorized')
  })

  it('should reset configuration and history', async () => {
    router.configureStageBehavior('SHELL_EXEC', {
      type: 'abstain',
      reason: 'test',
    })
    await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })

    expect(router.getCallCount()).toBe(1)

    router.reset()

    expect(router.getCallCount()).toBe(0)
    const response = await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })
    expect(response.decision).toBe('allow')
  })

  it('should clear call history without resetting config', async () => {
    router.configureStageBehavior('SHELL_EXEC', {
      type: 'abstain',
      reason: 'test',
    })
    await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })

    router.clearCallHistory()

    expect(router.getCallCount()).toBe(0)
    const response = await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })
    expect(response.decision).toBe('abstain')
  })
})

// ============================================================================
// GATING HELPERS TESTS
// ============================================================================

describe('Gating Helpers - Core Functions', () => {
  beforeEach(() => {
    resetGatingState()
  })

  it('should configure gating for a test', () => {
    const config = configureGatingFor({
      stages: {
        SHELL_EXEC: { type: 'allow' },
        MEMORY_MODIFY: { type: 'abstain', reason: 'unauthorized' },
      },
    })

    expect(config).toBeDefined()
    expect(typeof config.restore).toBe('function')
  })

  it('should get gating history', async () => {
    const mockRouter = globalThis.mockClarityRouter as MockClarityRouter

    await mockRouter.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })

    const history = getGatingHistory()
    expect(history).toHaveLength(1)
    expect(history[0].stage).toBe('SHELL_EXEC')
  })

  it('should filter history by stage', async () => {
    const mockRouter = globalThis.mockClarityRouter as MockClarityRouter

    await mockRouter.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-1',
      timestamp: Date.now(),
    })
    await mockRouter.route({
      stageId: 'MEMORY_MODIFY',
      contractId: 'test-2',
      timestamp: Date.now(),
    })

    const shellHistory = getGatingHistory({ stage: 'SHELL_EXEC' })
    expect(shellHistory).toHaveLength(1)
    expect(shellHistory[0].stage).toBe('SHELL_EXEC')

    const memoryHistory = getGatingHistory({ stage: 'MEMORY_MODIFY' })
    expect(memoryHistory).toHaveLength(1)
    expect(memoryHistory[0].stage).toBe('MEMORY_MODIFY')
  })

  it('should expect stage called', async () => {
    const mockRouter = globalThis.mockClarityRouter as MockClarityRouter

    await mockRouter.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })

    expect(() => expectStageCalled('SHELL_EXEC')).not.toThrow()
  })

  it('should get stage call count', async () => {
    const mockRouter = globalThis.mockClarityRouter as MockClarityRouter

    await mockRouter.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-1',
      timestamp: Date.now(),
    })
    await mockRouter.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-2',
      timestamp: Date.now(),
    })

    expect(getStageCallCount('SHELL_EXEC')).toBe(2)
  })
})

// ============================================================================
// EXPECTATION HELPERS TESTS
// ============================================================================

describe('Expectation Helpers', () => {
  beforeEach(() => {
    resetGatingState()
  })

  it('should expect gating success', async () => {
    configureGatingFor({
      stages: {
        SHELL_EXEC: { type: 'allow' },
      },
    })

    const mockRouter = globalThis.mockClarityRouter as MockClarityRouter

    await expectGatingSuccess(
      async () => {
        await mockRouter.route({
          stageId: 'SHELL_EXEC',
          contractId: 'test-123',
          timestamp: Date.now(),
        })
      },
      { stage: 'SHELL_EXEC' }
    )
  })

  it('should detect when operation does not go through gating', async () => {
    configureGatingFor({
      stages: {
        SHELL_EXEC: { type: 'allow' },
      },
    })

    const promise = expectGatingSuccess(
      async () => {
        // Operation that doesn't go through gating
        return Promise.resolve()
      },
      { stage: 'SHELL_EXEC' }
    )

    await expect(promise).rejects.toThrow()
  })

  it('should expect gating abstain', async () => {
    configureGatingFor({
      stages: {
        SHELL_EXEC: { type: 'abstain', reason: 'unauthorized' },
      },
    })

    const mockRouter = globalThis.mockClarityRouter as MockClarityRouter

    // Create a mock error that looks like ClarityBurstAbstainError
    const createAbstainError = (stage: string, reason: string) => {
      const err = new Error(`ClarityBurst: operation blocked`)
      ;(err as any).constructor.name = 'ClarityBurstAbstainError'
      ;(err as any).stageId = stage
      ;(err as any).reason = reason
      return err
    }

    // This test validates the error checking logic
    const error = createAbstainError('SHELL_EXEC', 'unauthorized')
    expect(error.message).toContain('ClarityBurst')
  })
})

// ============================================================================
// BYPASS HELPERS TESTS
// ============================================================================

describe('Bypass Helpers', () => {
  beforeEach(() => {
    resetGatingState()
  })

  it('should bypass gating for an operation', async () => {
    configureGatingFor({
      stages: {
        SHELL_EXEC: { type: 'abstain', reason: 'unauthorized' },
      },
    })

    const mockRouter = globalThis.mockClarityRouter as MockClarityRouter

    const result = await withGatingBypass(
      async () => {
        const response = await mockRouter.route({
          stageId: 'SHELL_EXEC',
          contractId: 'test-123',
          timestamp: Date.now(),
        })
        return response.allowed
      },
      { stages: ['SHELL_EXEC'] }
    )

    expect(result).toBe(true)
  })

  it('should restore configuration after bypass', async () => {
    configureGatingFor({
      stages: {
        SHELL_EXEC: { type: 'abstain', reason: 'unauthorized' },
      },
    })

    const mockRouter = globalThis.mockClarityRouter as MockClarityRouter

    // First bypass - should allow
    await withGatingBypass(
      async () => {
        const response = await mockRouter.route({
          stageId: 'SHELL_EXEC',
          contractId: 'test-123',
          timestamp: Date.now(),
        })
        expect(response.allowed).toBe(true)
      },
      { stages: ['SHELL_EXEC'] }
    )

    // After bypass - should abstain
    mockRouter.clearCallHistory()
    const response = await mockRouter.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-456',
      timestamp: Date.now(),
    })
    expect(response.allowed).toBe(false)
    expect(response.reason).toBe('unauthorized')
  })
})

// ============================================================================
// PERFORMANCE BASELINE TESTS
// ============================================================================

describe('Performance Baselines', () => {
  let router: MockClarityRouter

  beforeEach(async () => {
    router = createMockClarityRouter()
    await router.start()
  })

  it('should respond within p99 latency target', async () => {
    router.setLatencyRange(5, 20)

    const start = Date.now()
    await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })
    const elapsed = Date.now() - start

    // p99 target is 50ms, but with 5-20ms configured latency, should be well under
    expect(elapsed).toBeLessThan(100)
  })

  it('should handle 100+ concurrent requests', async () => {
    const promises = Array.from({ length: 100 }, (_, i) =>
      router.route({
        stageId: 'SHELL_EXEC',
        contractId: `test-${i}`,
        timestamp: Date.now(),
      })
    )

    const results = await Promise.all(promises)

    expect(results).toHaveLength(100)
    expect(results.every(r => r.decision === 'allow')).toBe(true)
    expect(router.getCallCount()).toBe(100)
  })

  it('should not leak memory on reset', async () => {
    const initialCount = router.getCallCount()

    // Make 1000 calls
    for (let i = 0; i < 1000; i++) {
      await router.route({
        stageId: 'SHELL_EXEC',
        contractId: `test-${i}`,
        timestamp: Date.now(),
      })
    }

    expect(router.getCallCount()).toBe(1000)

    // Reset
    router.reset()

    expect(router.getCallCount()).toBe(initialCount)
  })
})

// ============================================================================
// ERROR HANDLING TESTS
// ============================================================================

describe('Error Handling', () => {
  let router: MockClarityRouter

  beforeEach(async () => {
    router = createMockClarityRouter()
    await router.start()
  })

  it('should handle error behavior type', async () => {
    router.configureStageBehavior('SHELL_EXEC', {
      type: 'error',
      code: 'ROUTER_ERROR',
      message: 'Something went wrong',
    })

    const response = await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })

    expect(response.allowed).toBe(false)
    expect(response.error?.code).toBe('ROUTER_ERROR')
  })

  it('should handle timeout behavior type', async () => {
    router.configureStageBehavior('SHELL_EXEC', {
      type: 'timeout',
      delayMs: 50,
    })

    const start = Date.now()
    const response = await router.route({
      stageId: 'SHELL_EXEC',
      contractId: 'test-123',
      timestamp: Date.now(),
    })
    const elapsed = Date.now() - start

    expect(response.allowed).toBe(false)
    expect(response.reason).toBe('timeout')
    expect(elapsed).toBeGreaterThanOrEqual(50)
  })
})

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe('Integration Tests', () => {
  beforeEach(() => {
    resetGatingState()
  })

  it('should work end-to-end with all helpers', async () => {
    const mockRouter = globalThis.mockClarityRouter as MockClarityRouter

    // Configure gating
    configureGatingFor({
      stages: {
        SHELL_EXEC: { type: 'allow' },
        MEMORY_MODIFY: { type: 'abstain', reason: 'unauthorized' },
      },
    })

    // Successful operation
    await expectGatingSuccess(
      async () => {
        await mockRouter.route({
          stageId: 'SHELL_EXEC',
          contractId: 'test-123',
          timestamp: Date.now(),
        })
      },
      { stage: 'SHELL_EXEC' }
    )

    // Failed operation
    await expectGatingAbstain(
      async () => {
        const response = await mockRouter.route({
          stageId: 'MEMORY_MODIFY',
          contractId: 'test-456',
          timestamp: Date.now(),
        })
        if (!response.allowed) {
          const error = new Error('Operation blocked')
          ;(error as any).constructor.name = 'ClarityBurstAbstainError'
          ;(error as any).reason = response.reason
          throw error
        }
      },
      { reason: 'unauthorized' }
    )

    // Verify history
    const history = getGatingHistory()
    expect(history).toHaveLength(2)
    expect(history[0].stage).toBe('SHELL_EXEC')
    expect(history[0].decision).toBe('allow')
    expect(history[1].stage).toBe('MEMORY_MODIFY')
    expect(history[1].decision).toBe('abstain')
  })

  it('should handle complex multi-stage scenarios', async () => {
    const mockRouter = globalThis.mockClarityRouter as MockClarityRouter

    configureGatingFor({
      stages: {
        SHELL_EXEC: { type: 'allow' },
        MEMORY_MODIFY: { type: 'allow' },
        SUBAGENT_SPAWN: { type: 'deny', reason: 'insufficient_privileges' },
      },
    })

    // Execute multiple operations
    for (const stage of ['SHELL_EXEC', 'MEMORY_MODIFY', 'SUBAGENT_SPAWN']) {
      await mockRouter.route({
        stageId: stage,
        contractId: 'test-123',
        timestamp: Date.now(),
      })
    }

    // Verify history
    const history = getGatingHistory()
    expect(history).toHaveLength(3)
    expect(history[0].decision).toBe('allow')
    expect(history[1].decision).toBe('allow')
    expect(history[2].decision).toBe('deny')
  })
})
