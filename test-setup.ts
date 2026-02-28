/**
 * Vitest Test Setup File
 * 
 * Initializes test infrastructure including the mock clarity router
 * and gating-aware test helpers for all tests.
 * 
 * Phase: 2A Infrastructure Enhancement
 */

import { beforeAll, afterEach, afterAll } from 'vitest'
import { createMockClarityRouter } from './test-utilities/mock-clarity-router'

/**
 * Initialize mock clarity router before all tests
 */
beforeAll(async () => {
  // Create mock router instance
  const mockRouter = createMockClarityRouter()

  // Make it globally available
  globalThis.mockClarityRouter = mockRouter

  // Configure default behavior: allow all operations by default
  // Tests that need to validate specific gating behavior can override per-test
  mockRouter.setDefaultBehavior({
    type: 'allow',
    latency: { minMs: 0, maxMs: 5 } // Minimal latency for tests
  })

  // Start the router
  await mockRouter.start()
})

/**
 * Reset router state between each test
 */
afterEach(() => {
  const router = globalThis.mockClarityRouter
  if (router) {
    router.clearCallHistory()
  }
})

/**
 * Stop router after all tests
 */
afterAll(async () => {
  const router = globalThis.mockClarityRouter
  if (router) {
    await router.stop()
  }
})

// Type is already declared in gating-helpers.ts
