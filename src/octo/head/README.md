# Head Controller (`src/octo/head/`)

The Head Controller is the single authoritative supervisor for Octopus missions. It owns the mission graph, decides when grips become schedulable, issues and revokes leases, records every state transition to the event log, and arbitrates claims over shared artifacts. All `octo.*` side-effecting requests ultimately dispatch through services in this directory.

Per HLD §"Code layout and module boundaries", this module will house the following services (landing in Milestone 1 and later):

- `scheduler.ts` — `SchedulerService`: scoring, fairness, and dispatch of ready grips.
- `registry.ts` — `RegistryService`: SQLite content-addressed store for arms, grips, and missions.
- `event-log.ts` — `EventLogService`: append-only JSONL event log with replay support.
- `leases.ts` — `LeaseService`: time-bounded execution leases handed to Node Agents.
- `claims.ts` — `ClaimService`: exclusive-access claims over files, paths, and other shared resources.
- `artifacts.ts` — `ArtifactService`: artifact metadata and lookup across grips.
- `policy.ts` — `PolicyService`: stub through Milestone 4, active from Milestone 5 (see DECISIONS.md).
- `progress.ts` — `ProgressWatchdog`: detects stalled grips and triggers recovery.

No runtime code lives here yet; this README exists to reserve the directory and document intent. See `docs/octopus-orchestrator/LLD.md` §"Head Controller" for detailed contracts.
