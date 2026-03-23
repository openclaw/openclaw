// ─────────────────────────────────────────────
//  OpenClaw Shield — Security Layer
//  Integrated defense system for gateway protection
//  combining circuit breakers, session monitoring,
//  health scoring, and emergency escalation.
//
//  Based on Kairos Shield Protocol architecture.
//  By Kairos Lab
// ─────────────────────────────────────────────

// Layer 2: Session Protection
export {
  type SessionEvent,
  type AnomalyResult,
  THRESHOLDS,
  evaluateSession,
  detectAuthFlood,
  detectBruteForce,
  detectImpossibleTravel,
  detectDeviceSpray,
  detectGlobalFlood,
  detectGlobalFailureSpike,
  filterByWindow,
  filterByUser,
} from "./session-monitor.js";

export {
  type GeoLocation,
  type TravelAnalysis,
  EARTH_RADIUS_KM,
  IMPOSSIBLE_SPEED_KMH,
  haversineDistance,
  estimateSpeed,
  isImpossibleTravel,
  analyzeTravelBetween,
} from "./geo-distance.js";

// Layer 4: Gateway Function Monitoring
export {
  type CircuitState,
  type CircuitCheckResult,
  type CircuitRecordResult,
  CIRCUIT_CONFIG,
  checkCircuit,
  recordSuccess,
  recordFailure,
  createDefaultCircuit,
  shouldOpenCircuit,
  shouldTransitionToHalfOpen,
  evaluateHalfOpen,
  getNextCooldown,
} from "./circuit-breaker.js";

export {
  type FunctionMetrics,
  type FunctionHealth,
  type FunctionBaseline,
  type FunctionStatus,
  STATUS_THRESHOLDS,
  BASELINE_LEARNING_HOURS,
  calculateFunctionHealth,
  getFunctionStatus,
  calculatePercentile,
  buildFunctionBaseline,
  buildFunctionHealth,
} from "./function-health.js";

export {
  type ThrottleConfig,
  type ThrottleDecision,
  THROTTLE_RETRY_AFTER,
  getThrottleConfig,
  isRequestAllowed,
  calculateAllowedRPM,
  makeThrottleDecision,
} from "./function-throttle.js";

export {
  type EscalationAction,
  type EscalationResult,
  type PartialPauseConfig,
  type EmergencyPayload,
  GATEWAY_CRITICAL_FUNCTIONS,
  ESCALATION_RULES,
  TOTAL_FAILURE_THRESHOLD,
  MULTI_CRITICAL_THRESHOLD,
  evaluateEscalation,
  isGatewayCritical,
  getPartialPauseConfig,
  buildEmergencyPayload,
} from "./emergency-escalation.js";

// Metrics Collection
export {
  type RequestMetric,
  type AggregatedMetrics,
  FLUSH_INTERVAL_MS,
  FLUSH_SIZE,
  getWindowStart,
  aggregateByFunctionAndMinute,
  calculateErrorRate,
} from "./metrics-collector.js";

// Webhook Notifications
export {
  type WebhookPayload,
  type WebhookHeaders,
  type WebhookAttempt,
  type WebhookResult,
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAYS_MS,
  signWebhookPayload,
  verifyWebhookSignature,
  buildWebhookHeaders,
  getRetryDelay,
  shouldRetry,
  prepareWebhookDispatch,
} from "./webhook-dispatch.js";

// Gateway Shield Runtime
export { GatewayShield } from "./gateway-shield.js";
