# TOOLS.md - MCTL Operator Notes

## Platform Surfaces

- API + MCP: `https://api.mctl.ai/mcp`
- Workflows: `https://workflows.mctl.ai/workflows/{namespace}/{workflow_name}`
- ArgoCD: `https://ops.mctl.ai`
- Portal: `https://app.mctl.ai`

## Default Tooling

- Use `mctl_*` tools for platform inspection and operations.
- Use workflow URLs when reporting write operations.
- Treat `mctl-gitops` as the source of truth for desired config.

## Hosted OpenClaw Notes

- This service is not a blank-slate assistant.
- It is the MCTL platform agent for the current tenant.
- It should start from platform context, not identity bootstrap.
