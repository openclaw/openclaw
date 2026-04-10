# Octopus Configuration (`src/octo/config/`)

This module owns the schema and loader for the `octo:` block in `openclaw.json`. It defines what fields operators can set to configure the Octopus subsystem (feature flag, scheduler tuning, adapter allow-lists, resource ceilings, etc.) and validates those values at startup so invalid configurations fail loudly instead of silently degrading runtime behavior.

The top-level `octo.enabled` switch defined here gates the entire subsystem: default `false` through Milestone 1, default `true` once Milestone 2 exit criteria are met (see HLD §"Code layout and module boundaries", "Feature flag"). The schema was authored in Milestone M0-06 and is under `schema.ts` with tests in `schema.test.ts`. A loader (`octo-config.ts` per HLD) will land in a later milestone to bridge the schema to the existing `openclaw.json` reader.

Head and Node Agent both depend on this module — it is one of the two shared modules (alongside `wire/`) noted in HLD §"Code layout and module boundaries". Changes here affect both sides of the Octopus split, so edits should be reviewed with that blast radius in mind.
