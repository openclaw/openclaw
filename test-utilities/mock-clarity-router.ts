/**
 * Mock Clarity Router - Test Infrastructure Component
 * 
 * Simulates the clarity router for testing gating behavior without network dependency.
 * This implementation follows the specification in MOCK_CLARITY_ROUTER_SPECIFICATION.md
 * 
 * Phase: 2A Infrastructure Enhancement
 * Status: Production Implementation
 */

// Simple UUID generator (v4-like)
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * A request to gate an operation through a stage
 */
export interface GatingRequest {
  // Operation identifier
  stageId: string // e.g., 'SHELL_EXEC'
  contractId: string // Unique identifier for this operation

  // Authorization
  authorization?: {
    userId: string
    token: string
    permissions: string[]
  }

  // Operation context
  context?: {
    operation: string // e.g., 'execute'
    resource?: string // e.g., 'bash'
    metadata?: Record<string, any>
  }

  // Metadata
  timestamp: number // When request was made
  source?: string // 'test', 'production', etc.
}

/**
 * Response from the gating router
 */
export interface GatingResponse {
  // Decision
  allowed: boolean // Whether operation is allowed
  decision: 'allow' | 'abstain' | 'deny'

  // Stage tracking
  stageId: string
  contractId: string

  // If abstaining or denying
  reason?: string // Why operation blocked
  instructions?: string // User-friendly message

  // Router metadata
  routerTimestamp: number
  requestId: string // Unique request ID

  // Error (if decision is error)
  error?: {
    code: string
    message: string
    details?: Record<string, any>
  }
}

/**
 * Configured behavior for the router
 */
export type RouterBehavior =
  | AllowBehavior
  | AbstainBehavior
  | DenyBehavior
  | ErrorBehavior
  | TimeoutBehavior

export interface AllowBehavior {
  type: 'allow'
  approvalMethod?: 'automatic' | 'manual'
}

export interface AbstainBehavior {
  type: 'abstain'
  reason: string // e.g., 'unauthorized'
  instructions?: string // User-friendly message
}

export interface DenyBehavior {
  type: 'deny'
  reason: string
  instructions?: string
}

export interface ErrorBehavior {
  type: 'error'
  code: string // e.g., 'ROUTER_UNAVAILABLE'
  message: string
}

export interface TimeoutBehavior {
  type: 'timeout'
  delayMs: number
}

/**
 * Router configuration state
 */
export interface RouterConfiguration {
  // Behavior settings
  stageBehaviors: Record<string, RouterBehavior>
  defaultBehavior: RouterBehavior

  // Latency settings
  latency: {
    minMs: number
    maxMs: number
  }

  // Authorization settings
  authorizationRequired: boolean
  authorizedContracts: string[]

  // State
  isReady: boolean
  callCount: number
}

/**
 * Internal call record for inspection
 */
interface CallRecord {
  requestId: string
  timestamp: number
  request: GatingRequest
  response: GatingResponse
  processingTimeMs: number
}

/**
 * Mock clarity router interface
 */
export interface MockClarityRouter {
  // Core routing
  route(request: GatingRequest): Promise<GatingResponse>

  // Configuration
  configureStageBehavior(stage: string, behavior: RouterBehavior): void
  setDefaultBehavior(behavior: RouterBehavior): void
  setLatencyRange(minMs: number, maxMs: number): void
  setAuthorizationRequired(required: boolean): void
  setAuthorizedContracts(contracts: string[]): void

  // Inspection
  getCalls(stage?: string): GatingRequest[]
  getCallCount(stage?: string): number
  getResponses(stage?: string): GatingResponse[]
  getResponse(index: number): GatingResponse | undefined
  getLastResponse(): GatingResponse | undefined

  // State management
  reset(): void
  clearCallHistory(): void
  getConfiguration(): RouterConfiguration

  // Lifecycle
  start(): Promise<void>
  stop(): Promise<void>
  isReady(): boolean
}

// ============================================================================
// IMPLEMENTATION
// ============================================================================

/**
 * Creates a new mock clarity router instance
 */
export function createMockClarityRouter(): MockClarityRouter {
  // State
  let isReady = false
  const callHistory: CallRecord[] = []
  const requestHistory: GatingRequest[] = []
  const responseHistory: GatingResponse[] = []

  // Configuration
  let config: RouterConfiguration = {
    stageBehaviors: {},
    defaultBehavior: { type: 'allow' },
    latency: {
      minMs: 5,
      maxMs: 20,
    },
    authorizationRequired: false,
    authorizedContracts: [],
    isReady: false,
    callCount: 0,
  }

  /**
   * Apply latency delay
   */
  async function applyLatency(): Promise<void> {
    const delayMs = Math.random() * (config.latency.maxMs - config.latency.minMs) + config.latency.minMs
    return new Promise(resolve => setTimeout(resolve, delayMs))
  }

  /**
   * Get behavior for a stage
   */
  function getStageBehavior(stageId: string): RouterBehavior {
    return config.stageBehaviors[stageId] || config.defaultBehavior
  }

  /**
   * Process a gating request
   */
  async function processRequest(request: GatingRequest): Promise<GatingResponse> {
    const requestId = generateUUID()
    const requestStart = Date.now()

    try {
      // Validate router is ready
      if (!isReady) {
        const response: GatingResponse = {
          allowed: false,
          decision: 'abstain',
          stageId: request.stageId,
          contractId: request.contractId,
          reason: 'router_not_ready',
          instructions: 'Router is not yet initialized',
          routerTimestamp: Date.now(),
          requestId,
          error: {
            code: 'ROUTER_NOT_READY',
            message: 'Router has not been started',
          },
        }
        return response
      }

      // Apply latency
      await applyLatency()

      // Check authorization (if required)
      if (config.authorizationRequired && config.authorizedContracts.length > 0) {
        if (!config.authorizedContracts.includes(request.contractId)) {
          const response: GatingResponse = {
            allowed: false,
            decision: 'abstain',
            stageId: request.stageId,
            contractId: request.contractId,
            reason: 'unauthorized',
            instructions: 'This contract is not authorized for this operation',
            routerTimestamp: Date.now(),
            requestId,
          }
          recordCall(request, response, requestStart)
          return response
        }
      }

      // Get behavior for this stage
      const behavior = getStageBehavior(request.stageId)

      // Build response based on behavior
      let response: GatingResponse

      switch (behavior.type) {
        case 'allow':
          response = {
            allowed: true,
            decision: 'allow',
            stageId: request.stageId,
            contractId: request.contractId,
            routerTimestamp: Date.now(),
            requestId,
          }
          break

        case 'abstain':
          response = {
            allowed: false,
            decision: 'abstain',
            stageId: request.stageId,
            contractId: request.contractId,
            reason: behavior.reason,
            instructions: behavior.instructions,
            routerTimestamp: Date.now(),
            requestId,
          }
          break

        case 'deny':
          response = {
            allowed: false,
            decision: 'deny',
            stageId: request.stageId,
            contractId: request.contractId,
            reason: behavior.reason,
            instructions: behavior.instructions,
            routerTimestamp: Date.now(),
            requestId,
          }
          break

        case 'error':
          response = {
            allowed: false,
            decision: 'abstain',
            stageId: request.stageId,
            contractId: request.contractId,
            reason: behavior.code,
            routerTimestamp: Date.now(),
            requestId,
            error: {
              code: behavior.code,
              message: behavior.message,
            },
          }
          break

        case 'timeout':
          // Apply additional timeout delay
          await new Promise(resolve => setTimeout(resolve, behavior.delayMs))
          response = {
            allowed: false,
            decision: 'abstain',
            stageId: request.stageId,
            contractId: request.contractId,
            reason: 'timeout',
            instructions: 'Router request timed out',
            routerTimestamp: Date.now(),
            requestId,
          }
          break

        default:
          const _exhaustive: never = behavior
          throw new Error(`Unknown behavior type: ${_exhaustive}`)
      }

      // Record and return
      recordCall(request, response, requestStart)
      return response
    } catch (error) {
      // Unexpected error
      const response: GatingResponse = {
        allowed: false,
        decision: 'abstain',
        stageId: request.stageId,
        contractId: request.contractId,
        reason: 'internal_error',
        routerTimestamp: Date.now(),
        requestId,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      }
      recordCall(request, response, requestStart)
      return response
    }
  }

  /**
   * Record a call in history
   */
  function recordCall(request: GatingRequest, response: GatingResponse, startTime: number): void {
    const processingTimeMs = Date.now() - startTime
    const record: CallRecord = {
      requestId: response.requestId,
      timestamp: request.timestamp,
      request,
      response,
      processingTimeMs,
    }

    callHistory.push(record)
    requestHistory.push(request)
    responseHistory.push(response)
    config.callCount++
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  return {
    async route(request: GatingRequest): Promise<GatingResponse> {
      return processRequest(request)
    },

    configureStageBehavior(stage: string, behavior: RouterBehavior): void {
      config.stageBehaviors[stage] = behavior
    },

    setDefaultBehavior(behavior: RouterBehavior): void {
      config.defaultBehavior = behavior
    },

    setLatencyRange(minMs: number, maxMs: number): void {
      config.latency = { minMs, maxMs }
    },

    setAuthorizationRequired(required: boolean): void {
      config.authorizationRequired = required
    },

    setAuthorizedContracts(contracts: string[]): void {
      config.authorizedContracts = [...contracts]
    },

    getCalls(stage?: string): GatingRequest[] {
      if (!stage) {
        return [...requestHistory]
      }
      return requestHistory.filter(req => req.stageId === stage)
    },

    getCallCount(stage?: string): number {
      if (!stage) {
        return callHistory.length
      }
      return callHistory.filter(rec => rec.request.stageId === stage).length
    },

    getResponses(stage?: string): GatingResponse[] {
      if (!stage) {
        return [...responseHistory]
      }
      return responseHistory.filter(res => res.stageId === stage)
    },

    getResponse(index: number): GatingResponse | undefined {
      return responseHistory[index]
    },

    getLastResponse(): GatingResponse | undefined {
      return responseHistory[responseHistory.length - 1]
    },

    reset(): void {
      callHistory.length = 0
      requestHistory.length = 0
      responseHistory.length = 0
      config = {
        stageBehaviors: {},
        defaultBehavior: { type: 'allow' },
        latency: {
          minMs: 5,
          maxMs: 20,
        },
        authorizationRequired: false,
        authorizedContracts: [],
        isReady,
        callCount: 0,
      }
    },

    clearCallHistory(): void {
      callHistory.length = 0
      requestHistory.length = 0
      responseHistory.length = 0
      config.callCount = 0
    },

    getConfiguration(): RouterConfiguration {
      return {
        stageBehaviors: { ...config.stageBehaviors },
        defaultBehavior: config.defaultBehavior,
        latency: { ...config.latency },
        authorizationRequired: config.authorizationRequired,
        authorizedContracts: [...config.authorizedContracts],
        isReady,
        callCount: config.callCount,
      }
    },

    async start(): Promise<void> {
      isReady = true
      config.isReady = true
    },

    async stop(): Promise<void> {
      isReady = false
      config.isReady = false
    },

    isReady(): boolean {
      return isReady
    },
  }
}

// ============================================================================
// CONVENIENCE EXPORTS
// ============================================================================

export class ClarityBurstRouterError extends Error {
  constructor(
    public code: string,
    public details?: Record<string, any>
  ) {
    super(`ClarityRouter Error [${code}]`)
    Object.setPrototypeOf(this, ClarityBurstRouterError.prototype)
  }
}
