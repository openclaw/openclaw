# OpenClaw Shield — Security Hardening Layer

> Integrated defense system for OpenClaw gateway protection.
> Based on [Kairos Shield Protocol](https://github.com/kairos-lab/kairos-shield) architecture.
> **By Kairos Lab**

---

## Overview

OpenClaw Shield is a security hardening layer that brings production-grade protection to the OpenClaw gateway. It addresses critical vulnerabilities identified during a comprehensive security audit and introduces 6 defense modules adapted from the Kairos Shield Protocol.

## Security Patches Applied

### Critical Fixes

| Vulnerability                          | File                                        | Fix                                                                                         |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Command Injection via `exec()`**     | `src/gateway/server-methods/config.ts`      | Replaced `exec()` with `execFile()` to prevent shell injection                              |
| **Unsafe `eval()` in browser context** | `src/browser/pw-tools-core.interactions.ts` | Added blocked pattern regex to reject prototype pollution, constructor access, and import() |
| **Loopback rate-limit bypass**         | `src/gateway/auth-rate-limit.ts`            | Added 10x throttled limit for loopback addresses instead of full exemption                  |
| **Missing security headers**           | `src/gateway/control-ui-csp.ts`             | Added X-Frame-Options, COOP, CORP, Referrer-Policy, Permissions-Policy                      |

## Shield Modules

### Layer 2: Session Protection

**`session-monitor.ts`** — 6 deterministic anomaly detection rules:

| Rule                 | Trigger                              | Action   |
| -------------------- | ------------------------------------ | -------- |
| Auth Flood           | >20 auths in 5min per user           | restrict |
| Brute Force          | >5 failed auths in 10min             | restrict |
| Impossible Travel    | >900 km/h between events (Haversine) | warn     |
| Device Spray         | >5 distinct devices in 1h            | restrict |
| Global Auth Flood    | >1000 auths in 5min platform-wide    | warn     |
| Global Failure Spike | >30% failure rate (min 50 events)    | warn     |

**`geo-distance.ts`** — Haversine great-circle distance + speed estimation.

### Layer 4: Gateway Function Monitoring

**`circuit-breaker.ts`** — 3-state circuit breaker with exponential backoff:

```
CLOSED ──(10 failures)──> OPEN ──(60s cooldown)──> HALF_OPEN ──(4/5 success)──> CLOSED
                           ▲                                        │
                           └──(failures, 2x cooldown)───────────────┘
```

**`function-health.ts`** — Health score calculation (0-100):

- Error rate penalties (biggest impact)
- Latency vs baseline penalties
- Timeout penalties
- Volume anomaly detection

**`function-throttle.ts`** — Progressive rate limiting:

- HEALTHY (80-100): 100% capacity
- DEGRADED (50-79): 50-95% capacity with queueing
- CRITICAL (25-49): 5-25% capacity
- CIRCUIT_OPEN (0-24): 0% capacity

**`emergency-escalation.ts`** — Multi-function failure detection:

- SINGLE_CRITICAL → ALERT
- MULTI_CRITICAL (3+) → PARTIAL_PAUSE
- GATEWAY_PIPELINE_DOWN → PARTIAL_PAUSE
- TOTAL_FAILURE (10+) → FULL_PAUSE

**`metrics-collector.ts`** — Per-minute request aggregation with percentile calculation.

### Notifications

**`webhook-dispatch.ts`** — HMAC-SHA256 signed webhooks with retry logic (1s, 4s, 16s backoff).

### WebSocket Hardening

**`ws-validation.ts`** — Origin validation, payload size limits, per-connection rate tracking, device fingerprinting.

## Integration

### Gateway Shield Runtime

The `GatewayShield` class is the main orchestrator. Initialize once at gateway startup:

```typescript
import { GatewayShield } from "./security/shield/index.js";

const shield = new GatewayShield({
  circuitBreakerEnabled: true,
  sessionMonitorEnabled: true,
  healthScoringEnabled: true,
  escalationEnabled: true,
  maxWsPayloadBytes: 10 * 1024 * 1024,
  maxPreAuthPayloadBytes: 64 * 1024,
  allowedOrigins: [],
  webhookUrl: "",
  webhookSecret: "",
});

// On each gateway function call:
const check = shield.checkCircuit("ws-handler");
if (!check.allowed) {
  // Return 503 with Retry-After header
}

// After success/failure:
shield.recordSuccess("ws-handler");
shield.recordFailure("ws-handler");

// On auth events:
const anomalies = shield.processAuthEvent({
  user_id: "...",
  event_type: "LOGIN",
  ip_address: "...",
  // ...
});

// Periodically compute health scores:
shield.computeHealthScores();

// Get diagnostics:
console.log(shield.getSummary());
```

## Testing

```bash
pnpm test -- src/security/shield/shield.test.ts
```

50+ tests covering all modules: circuit breaker state machine, session anomaly rules, geo-distance math, health scoring, throttle decisions, escalation rules, metrics aggregation, webhook signing, WebSocket validation, and end-to-end GatewayShield integration.

## Architecture

```
src/security/shield/
├── index.ts                  # Public API barrel
├── gateway-shield.ts         # Main runtime orchestrator
├── circuit-breaker.ts        # 3-state circuit breaker
├── session-monitor.ts        # 6 anomaly detection rules
├── geo-distance.ts           # Haversine + impossible travel
├── function-health.ts        # Health score calculation
├── function-throttle.ts      # Progressive rate limiting
├── emergency-escalation.ts   # Multi-function failure escalation
├── metrics-collector.ts      # Request metrics aggregation
├── webhook-dispatch.ts       # HMAC-SHA256 signed notifications
├── ws-validation.ts          # WebSocket origin + payload validation
├── shield.test.ts            # Comprehensive test suite
└── SHIELD.md                 # This file
```

All modules are **pure functions** with zero external dependencies (Node.js `crypto` only). No database, no network calls, no side effects — designed for testability and minimal footprint.

## Credits

Security architecture adapted from [Kairos Shield Protocol](https://github.com/kairos-lab/kairos-shield) by **Kairos Lab**.
