// Octopus Orchestrator — wire primitives
//
// Shared TypeBox primitives reused across octo wire schemas (ArmSpec,
// GripSpec, MissionSpec, event envelopes, etc.). Intentionally *not*
// importing from `src/gateway/protocol/schema/primitives.ts` — see
// DECISIONS.md OCTO-DEC-033, which forbids OpenClaw internal imports from
// outside `src/octo/adapters/openclaw/`. The duplication of trivial
// primitives is the explicit cost of that isolation; in exchange we get
// insulation from gateway protocol evolution.
//
// When we need to reuse a non-trivial gateway primitive, the right move
// is a bridge file under `src/octo/adapters/openclaw/` (per OCTO-DEC-033),
// not a direct import here.

import { Type } from "@sinclair/typebox";

// A string with at least one character. Used for identifiers, runtime
// names, paths, and other fields where the empty string is never valid.
export const NonEmptyString = Type.String({ minLength: 1 });
