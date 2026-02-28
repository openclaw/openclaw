/**
 * Gating-Aware Test Helpers - Test Infrastructure Utilities
 * 
 * Utility functions that make it straightforward to write tests that validate gating behavior.
 * These helpers reduce boilerplate code, improve test clarity, and document expected gating patterns.
 * 
 * Phase: 2A Infrastructure Enhancement
 * Status: Production Implementation
 */

import type { MockClarityRouter, GatingRequest, RouterBehavior } from './mock-clarity-router'

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Options for expectGatingAbstain helper
 */
export interface AbstainOptions {
  stage?: string // Expected gating stage (e.g., 'SHELL_EXEC')
  reason?: string // Expected abstain reason
  errorMessage?: RegExp | string // Expected error message pattern
}

/**
 * Options for withGatingBypass helper
 */
export interface BypassOptions {
  stages?: string[] // Which stages to bypass (default: all)
  approval?: string // Simulated approval token
}

/**
 * Options for expectGatingSuccess helper
 */
export interface SuccessOptions {
  stage?: string // Expected gating stage
  contractId?: string // Expected contract ID
}

/**
 * Options for configureGatingFor helper
 */
export interface GatingConfiguration {
  stages?: Record<string, RouterBehavior> // Per-stage configuration
  defaultBehavior?: RouterBehavior // Fallback behavior
  authorizationRequired?: boolean // Enforce auth checks
  authorizedContracts?: string[] // Pre-authorized contracts
  latency?: {
    minMs?: number
    maxMs?: number
  }
}

/**
 * Handle returned from configureGatingFor
 */
export interface ConfigurationHandle {
  restore(): void // Restore previous config
  getConfiguration(): any // Get current config
}

/**
 * Gating decision record
 */
export interface GatingDecision {
  timestamp: number // When decision was made
  stage: string // Gating stage (e.g., 'SHELL_EXEC')
  contractId: string // Contract being gated
  decision: 'allow' | 'abstain' | 'deny' // Decision type
  reason?: string // Why decision made
  latencyMs: number // Router response latency
  requestId: string // Unique request ID
}

/**
 * Options for getGatingHistory helper
 */
export interface HistoryOptions {
  stage?: string // Filter by stage
  limit?: number // Most recent N calls
}

// ============================================================================
// GLOBAL TYPE AUGMENTATION
// ============================================================================

declare global {
  // eslint-disable-next-line no-var
  var mockClarityRouter: MockClarityRouter | undefined
}

// ============================================================================
// ASSERTION ERROR CLASS
// ============================================================================

export class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    Object.setPrototypeOf(this, AssertionError.prototype)
  }
}

// ============================================================================
// ERROR CHECKING UTILITIES
// ============================================================================

/**
 * Check if an error is a ClarityBurstAbstainError
 */
function isClarityBurstAbstainError(error: unknown): boolean {
  const err = error as any
  return (
    err &&
    err.constructor &&
    (err.constructor.name === 'ClarityBurstAbstainError' ||
      err.message?.includes('ClarityBurst') ||
      err.name === 'ClarityBurstAbstainError')
  )
}

/**
 * Extract error metadata from ClarityBurstAbstainError
 */
function extractErrorMetadata(error: unknown): { stageId?: string; reason?: string } {
  const err = error as any
  return {
    stageId: err?.stageId || err?.stage,
    reason: err?.reason || err?.details?.reason,
  }
}

/**
 * Get or throw if mock router not initialized
 */
function getMockRouterOrThrow(): MockClarityRouter {
  const router = globalThis.mockClarityRouter
  if (!router) {
    throw new Error('Mock clarity router not initialized - did you call router.start() in test setup?')
  }
  return router
}

// ============================================================================
// HELPER 1: expectGatingAbstain
// ============================================================================

/**
 * Assert that an operation was blocked by gating
 * 
 * Usage:
 * ```typescript
 * await expectGatingAbstain(
 *   () => shellTool.exec('echo test'),
 *   { stage: 'SHELL_EXEC', reason: 'unauthorized' }
 * )
 * ```
 */
export async function expectGatingAbstain(
  operation: () => Promise<unknown>,
  options: AbstainOptions = {}
): Promise<void> {
  try {
    await operation()
    throw new AssertionError('Expected operation to be abstained by gating, but it succeeded')
  } catch (error) {
    // Verify it's a gating abstain error
    if (!isClarityBurstAbstainError(error)) {
      throw error
    }

    const metadata = extractErrorMetadata(error)

    // Verify stage if specified
    if (options.stage && metadata.stageId && metadata.stageId !== options.stage) {
      throw new AssertionError(
        `Expected abstain at stage ${options.stage}, got ${metadata.stageId}`
      )
    }

    // Verify reason if specified
    if (options.reason && metadata.reason !== options.reason) {
      throw new AssertionError(`Expected reason ${options.reason}, got ${metadata.reason}`)
    }

    // Verify message if specified
    if (options.errorMessage) {
      const err = error as any
      const pattern =
        typeof options.errorMessage === 'string'
          ? new RegExp(options.errorMessage)
          : options.errorMessage

      if (!pattern.test(err.message)) {
        throw new AssertionError(
          `Expected error message matching ${pattern}, got: ${err.message}`
        )
      }
    }
  }
}

// ============================================================================
// HELPER 2: withGatingBypass
// ============================================================================

/**
 * Execute operation with gating bypass for a specific test
 * 
 * Usage:
 * ```typescript
 * const result = await withGatingBypass(
 *   () => sessionMemory.create({ id: 'test-session' }),
 *   { stages: ['MEMORY_MODIFY'] }
 * )
 * ```
 */
export async function withGatingBypass<T>(
  operation: () => Promise<T>,
  options: BypassOptions = {}
): Promise<T> {
  // Get current configuration
  const router = getMockRouterOrThrow()
  const previousConfig = router.getConfiguration()

  try {
    // Apply bypass configuration
    const stagesToBypass = options.stages || Object.keys(previousConfig.stageBehaviors)

    for (const stage of stagesToBypass) {
      router.configureStageBehavior(stage, { type: 'allow' })
    }

    // Execute operation
    return await operation()
  } finally {
    // Restore previous configuration
    router.reset()
    Object.entries(previousConfig.stageBehaviors).forEach(([stage, behavior]) => {
      router.configureStageBehavior(stage, behavior)
    })
  }
}

// ============================================================================
// HELPER 3: expectGatingSuccess
// ============================================================================

/**
 * Assert that operation proceeded through gating successfully
 * 
 * Usage:
 * ```typescript
 * await expectGatingSuccess(
 *   () => shellTool.exec('echo test'),
 *   { stage: 'SHELL_EXEC' }
 * )
 * ```
 */
export async function expectGatingSuccess(
  operation: () => Promise<unknown>,
  options: SuccessOptions = {}
): Promise<void> {
  try {
    const router = getMockRouterOrThrow()

    // Configure to allow the operation
    if (options.stage) {
      router.configureStageBehavior(options.stage, {
        type: 'allow',
      })
    }

    // Execute operation
    await operation()

    // Verify the gating response
    if (options.stage) {
      const response = router.getLastResponse()
      if (!response) {
        throw new AssertionError('No gating response recorded')
      }

      if (response.decision !== 'allow') {
        throw new AssertionError(`Expected decision 'allow', got '${response.decision}'`)
      }

      if (response.stageId !== options.stage) {
        throw new AssertionError(`Expected stage ${options.stage}, got ${response.stageId}`)
      }
    }
  } catch (error) {
    // Gating errors should not happen - operation should succeed
    if (isClarityBurstAbstainError(error)) {
      const metadata = extractErrorMetadata(error)
      throw new AssertionError(
        `Expected operation to succeed through gating, but was abstained: ${metadata.reason}`
      )
    }
    throw error
  }
}

// ============================================================================
// HELPER 4: configureGatingFor
// ============================================================================

/**
 * Configure gating behavior for a specific test
 * 
 * Usage:
 * ```typescript
 * const config = configureGatingFor({
 *   stages: {
 *     SHELL_EXEC: { type: 'abstain', reason: 'unauthorized' }
 *   }
 * })
 * ```
 */
export function configureGatingFor(options: GatingConfiguration): ConfigurationHandle {
  const router = getMockRouterOrThrow()
  const previousConfig = router.getConfiguration()

  // Apply new configuration
  if (options.stages) {
    Object.entries(options.stages).forEach(([stage, behavior]) => {
      router.configureStageBehavior(stage, behavior)
    })
  }

  if (options.defaultBehavior) {
    router.setDefaultBehavior(options.defaultBehavior)
  }

  if (options.authorizationRequired !== undefined) {
    router.setAuthorizationRequired(options.authorizationRequired)
  }

  if (options.authorizedContracts) {
    router.setAuthorizedContracts(options.authorizedContracts)
  }

  if (options.latency) {
    const min = options.latency.minMs ?? 5
    const max = options.latency.maxMs ?? 20
    router.setLatencyRange(min, max)
  }

  return {
    restore() {
      router.reset()
      Object.entries(previousConfig.stageBehaviors).forEach(([stage, behavior]) => {
        router.configureStageBehavior(stage, behavior)
      })
      if (previousConfig.defaultBehavior) {
        router.setDefaultBehavior(previousConfig.defaultBehavior)
      }
      if (previousConfig.authorizationRequired) {
        router.setAuthorizationRequired(previousConfig.authorizationRequired)
      }
      if (previousConfig.authorizedContracts.length > 0) {
        router.setAuthorizedContracts(previousConfig.authorizedContracts)
      }
    },
    getConfiguration() {
      return router.getConfiguration()
    },
  }
}

// ============================================================================
// HELPER 5: getGatingHistory
// ============================================================================

/**
 * Inspect gating decisions made during test
 * 
 * Usage:
 * ```typescript
 * const history = getGatingHistory({ stage: 'SHELL_EXEC' })
 * expect(history).toHaveLength(3)
 * expect(history[0].decision).toBe('allow')
 * ```
 */
export function getGatingHistory(options?: HistoryOptions): GatingDecision[] {
  const router = getMockRouterOrThrow()

  const calls = router.getCalls(options?.stage)
  const responses = router.getResponses(options?.stage)

  // Pair requests with responses
  const decisions = calls.map((call: GatingRequest, index: number) => {
    const response = responses[index]
    return {
      timestamp: call.timestamp,
      stage: call.stageId,
      contractId: call.contractId,
      decision: response.decision,
      reason: response.reason,
      latencyMs: response.routerTimestamp - call.timestamp,
      requestId: response.requestId,
    }
  })

  // Apply limit if specified
  if (options?.limit) {
    return decisions.slice(-options.limit)
  }

  return decisions
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get the mock router instance (for advanced use cases)
 */
export function getMockRouter(): MockClarityRouter {
  return getMockRouterOrThrow()
}

/**
 * Reset router state between tests
 */
export function resetGatingState(): void {
  const router = globalThis.mockClarityRouter
  if (router) {
    router.clearCallHistory()
  }
}

/**
 * Verify that a stage was called with gating
 */
export function expectStageCalled(stage: string): void {
  const router = getMockRouterOrThrow()

  const calls = router.getCalls(stage)
  if (calls.length === 0) {
    throw new AssertionError(`Expected stage ${stage} to be called, but it was not`)
  }
}

/**
 * Verify that a stage was NOT called with gating
 */
export function expectStageNotCalled(stage: string): void {
  const router = getMockRouterOrThrow()

  const calls = router.getCalls(stage)
  if (calls.length > 0) {
    throw new AssertionError(
      `Expected stage ${stage} to not be called, but it was called ${calls.length} times`
    )
  }
}

/**
 * Get count of calls for a stage
 */
export function getStageCallCount(stage: string): number {
  const router = getMockRouterOrThrow()
  return router.getCallCount(stage)
}

// ============================================================================
// EXPORTS FOR GLOBAL DECLARATION
// ============================================================================

export const gatingHelpers = {
  expectGatingAbstain,
  withGatingBypass,
  expectGatingSuccess,
  configureGatingFor,
  getGatingHistory,
  getMockRouter,
  resetGatingState,
  expectStageCalled,
  expectStageNotCalled,
  getStageCallCount,
}
