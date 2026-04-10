# Upstream Isolation Bridge (`src/octo/adapters/openclaw/`)

This directory holds the thin bridge layer that isolates Octopus adapters from direct dependencies on upstream OpenClaw internals. Per OCTO-DEC-033, Octopus must not reach into OpenClaw module paths directly from adapter implementations; instead, every call into `sessions_spawn`, Gateway internals, or habitat APIs is mediated by a dedicated function defined here.

The goal is twofold: (1) protect Octopus from churn in upstream OpenClaw refactors by centralizing the seam, and (2) make it possible to stub the upstream surface in unit tests without pulling in the full Gateway or session manager. Bridge files typically re-export narrow, typed functions that adapters consume in place of deep imports.

No runtime code exists here yet — Milestone 0 only reserves the directory. The first bridge functions will land in Milestone 1 (M0-10 and beyond) alongside the initial `SubagentAdapter` implementation. See `docs/octopus-orchestrator/DECISIONS.md` entry OCTO-DEC-033 for the full rationale.
