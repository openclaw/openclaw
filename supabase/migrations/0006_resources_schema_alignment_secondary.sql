-- 0006 - Align secondary `resources` catalog columns with the platform schema
--
-- Why: the open-operations (secondary) `resources` table predates the platform
-- catalog and was missing `owner_id` and the `package_*` metadata columns.
-- The 0005 transfer copies resource rows from open-platform, but
-- jsonb_populate_recordset silently drops keys that have no matching column,
-- so `owner_id` was lost on insert (it arrived NULL).
--
-- This migration adds the missing columns (all nullable, additive, no data
-- rewrite) and mirrors the platform FK behaviour (ON DELETE CASCADE). Applied
-- 2026-11-20; the six transferred resources were then backfilled with their
-- original owner_id and updated_at values, achieving field-level parity with
-- open-platform.
--
-- Safe to re-run (IF NOT EXISTS). Doesn't touch existing rows.

ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS package_path text;

ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS package_filename text;

ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS package_size bigint;

ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS package_mime text;
