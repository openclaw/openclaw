-- 0005 destination registry schema for open-operations (additive, idempotent)
CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, slug text NOT NULL,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT organizations_slug_key UNIQUE (slug));
CREATE TABLE IF NOT EXISTS public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL, slug text NOT NULL, description text,
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT workspaces_organization_id_slug_key UNIQUE (organization_id, slug));
CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, slug text NOT NULL, description text,
  created_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT projects_organization_id_slug_key UNIQUE (organization_id, slug));
CREATE TABLE IF NOT EXISTS public.environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL, slug text NOT NULL, is_default boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT environments_project_id_slug_key UNIQUE (project_id, slug));
CREATE TABLE IF NOT EXISTS public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text DEFAULT 'member',
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT organization_members_organization_id_user_id_key UNIQUE (organization_id, user_id));
CREATE TABLE IF NOT EXISTS public.project_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text DEFAULT 'member',
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT project_members_project_id_user_id_key UNIQUE (project_id, user_id));
CREATE TABLE IF NOT EXISTS public.project_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES public.resources(id) ON DELETE CASCADE,
  added_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT, notes text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT project_resources_project_resource_key UNIQUE (project_id, resource_id));
CREATE TABLE IF NOT EXISTS public.project_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.app_connections(id) ON DELETE CASCADE,
  added_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  CONSTRAINT project_connections_project_id_connection_id_key UNIQUE (project_id, connection_id));
CREATE TABLE IF NOT EXISTS public.cross_db_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_project text NOT NULL, target_project text NOT NULL,
  table_name text NOT NULL, source_id uuid NOT NULL, target_id uuid NOT NULL,
  note text, identity_remap jsonb, transferred_at timestamptz DEFAULT now(),
  CONSTRAINT cross_db_references_uniq UNIQUE (source_project, table_name, source_id));
CREATE TABLE IF NOT EXISTS public.migration_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_name text NOT NULL UNIQUE, source_project text, target_project text,
  status text DEFAULT 'pending', baseline jsonb, result jsonb, applied_at timestamptz DEFAULT now());
-- helper functions (exact primary definitions)
CREATE OR REPLACE FUNCTION public.is_project_member(target_project_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $fn$ select exists (select 1 from public.project_members pm where pm.project_id = target_project_id and pm.user_id = auth.uid()); $fn$;
CREATE OR REPLACE FUNCTION public.is_organization_member(target_organization_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $fn$ select exists (select 1 from public.organization_members om where om.organization_id = target_organization_id and om.user_id = auth.uid()); $fn$;
CREATE OR REPLACE FUNCTION public.can_manage_project(target_project_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $fn$ select exists (select 1 from public.projects p where p.id = target_project_id and p.created_by = auth.uid()) or exists (select 1 from public.organization_members om join public.projects p on p.organization_id = om.organization_id where p.id = target_project_id and om.user_id = auth.uid() and om.role in ('owner','admin')); $fn$;
CREATE OR REPLACE FUNCTION public.can_access_project(target_project_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $fn$ select exists (select 1 from public.projects p where p.id = target_project_id and p.created_by = auth.uid()) or exists (select 1 from public.project_members pm where pm.project_id = target_project_id and pm.user_id = auth.uid()) or exists (select 1 from public.projects p join public.workspaces w on w.id = p.workspace_id join public.organizations o on o.id = w.organization_id where p.id = target_project_id and o.owner_id = auth.uid()) or exists (select 1 from public.projects p join public.organization_members om on om.organization_id = p.organization_id where p.id = target_project_id and om.user_id = auth.uid()); $fn$;
CREATE OR REPLACE FUNCTION public.can_manage_organization(target_organization_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $fn$ select exists (select 1 from public.organizations o where o.id = target_organization_id and o.owner_id = auth.uid()) or exists (select 1 from public.organization_members om where om.organization_id = target_organization_id and om.user_id = auth.uid() and om.role in ('owner','admin')); $fn$;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cross_db_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.migration_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS xref_service_all ON public.cross_db_references;
CREATE POLICY xref_service_all ON public.cross_db_references FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS migstate_service_all ON public.migration_state;
CREATE POLICY migstate_service_all ON public.migration_state FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS org_members_select ON public.organizations;
CREATE POLICY org_members_select ON public.organizations FOR SELECT TO public USING (is_organization_member(id));
DROP POLICY IF EXISTS org_owner_all ON public.organizations;
CREATE POLICY org_owner_all ON public.organizations FOR ALL TO public USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS workspace_delete ON public.workspaces;
CREATE POLICY workspace_delete ON public.workspaces FOR DELETE TO public USING (can_manage_organization(organization_id));
DROP POLICY IF EXISTS workspace_insert ON public.workspaces;
CREATE POLICY workspace_insert ON public.workspaces FOR INSERT TO public WITH CHECK (can_manage_organization(organization_id));
DROP POLICY IF EXISTS workspace_select ON public.workspaces;
CREATE POLICY workspace_select ON public.workspaces FOR SELECT TO public USING (is_organization_member(organization_id));
DROP POLICY IF EXISTS workspace_update ON public.workspaces;
CREATE POLICY workspace_update ON public.workspaces FOR UPDATE TO public USING (can_manage_organization(organization_id)) WITH CHECK (can_manage_organization(organization_id));
DROP POLICY IF EXISTS project_delete ON public.projects;
CREATE POLICY project_delete ON public.projects FOR DELETE TO public USING (can_manage_project(id));
DROP POLICY IF EXISTS project_insert ON public.projects;
CREATE POLICY project_insert ON public.projects FOR INSERT TO public WITH CHECK (can_manage_organization(organization_id));
DROP POLICY IF EXISTS project_select ON public.projects;
CREATE POLICY project_select ON public.projects FOR SELECT TO public USING (can_access_project(id));
DROP POLICY IF EXISTS project_update ON public.projects;
CREATE POLICY project_update ON public.projects FOR UPDATE TO public USING (can_manage_project(id)) WITH CHECK (can_manage_project(id));
DROP POLICY IF EXISTS env_delete ON public.environments;
CREATE POLICY env_delete ON public.environments FOR DELETE TO public USING (can_manage_project(project_id));
DROP POLICY IF EXISTS env_insert ON public.environments;
CREATE POLICY env_insert ON public.environments FOR INSERT TO public WITH CHECK (can_manage_project(project_id));
DROP POLICY IF EXISTS env_select ON public.environments;
CREATE POLICY env_select ON public.environments FOR SELECT TO public USING (is_project_member(project_id));
DROP POLICY IF EXISTS env_update ON public.environments;
CREATE POLICY env_update ON public.environments FOR UPDATE TO public USING (can_manage_project(project_id)) WITH CHECK (can_manage_project(project_id));
DROP POLICY IF EXISTS org_members_insert ON public.organization_members;
CREATE POLICY org_members_insert ON public.organization_members FOR INSERT TO public WITH CHECK (can_manage_organization(organization_id));
DROP POLICY IF EXISTS org_members_delete ON public.organization_members;
CREATE POLICY org_members_delete ON public.organization_members FOR DELETE TO public USING (can_manage_organization(organization_id));
DROP POLICY IF EXISTS org_members_update ON public.organization_members;
CREATE POLICY org_members_update ON public.organization_members FOR UPDATE TO public USING (can_manage_organization(organization_id)) WITH CHECK (can_manage_organization(organization_id));
DROP POLICY IF EXISTS proj_members_delete ON public.project_members;
CREATE POLICY proj_members_delete ON public.project_members FOR DELETE TO public USING (can_manage_project(project_id));
DROP POLICY IF EXISTS proj_members_insert ON public.project_members;
CREATE POLICY proj_members_insert ON public.project_members FOR INSERT TO public WITH CHECK (can_manage_project(project_id));
DROP POLICY IF EXISTS proj_members_select ON public.project_members;
CREATE POLICY proj_members_select ON public.project_members FOR SELECT TO public USING (is_project_member(project_id));
DROP POLICY IF EXISTS proj_members_update ON public.project_members;
CREATE POLICY proj_members_update ON public.project_members FOR UPDATE TO public USING (can_manage_project(project_id)) WITH CHECK (can_manage_project(project_id));
DROP POLICY IF EXISTS proj_res_delete ON public.project_resources;
CREATE POLICY proj_res_delete ON public.project_resources FOR DELETE TO public USING (can_manage_project(project_id));
DROP POLICY IF EXISTS proj_res_insert ON public.project_resources;
CREATE POLICY proj_res_insert ON public.project_resources FOR INSERT TO public WITH CHECK (can_manage_project(project_id));
DROP POLICY IF EXISTS proj_res_select ON public.project_resources;
CREATE POLICY proj_res_select ON public.project_resources FOR SELECT TO public USING (is_project_member(project_id));
DROP POLICY IF EXISTS proj_res_update ON public.project_resources;
CREATE POLICY proj_res_update ON public.project_resources FOR UPDATE TO public USING (can_manage_project(project_id)) WITH CHECK (can_manage_project(project_id));
DROP POLICY IF EXISTS proj_conn_delete ON public.project_connections;
CREATE POLICY proj_conn_delete ON public.project_connections FOR DELETE TO public USING (can_manage_project(project_id));
DROP POLICY IF EXISTS proj_conn_insert ON public.project_connections;
CREATE POLICY proj_conn_insert ON public.project_connections FOR INSERT TO public WITH CHECK (can_manage_project(project_id));
DROP POLICY IF EXISTS proj_conn_select ON public.project_connections;
CREATE POLICY proj_conn_select ON public.project_connections FOR SELECT TO public USING (is_project_member(project_id));
DROP POLICY IF EXISTS proj_conn_update ON public.project_connections;
CREATE POLICY proj_conn_update ON public.project_connections FOR UPDATE TO public USING (can_manage_project(project_id)) WITH CHECK (can_manage_project(project_id));
