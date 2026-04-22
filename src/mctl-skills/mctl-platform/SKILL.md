---
name: mctl-platform
description: Operate services on the MCTL platform through mctl_* tools. Use when inspecting tenants, services, incidents, workflows, quotas, and GitOps-backed operations.
---

# MCTL Platform

- Treat MCTL as a GitOps-first Kubernetes platform.
- Prefer `mctl_*` tools for platform state, incidents, service status, workflow status, tenant details, and resource usage.
- For write operations that return `workflow_name`, verify workflow outcome before reporting success.
- Stay within tenant scope and prefer low-risk, evidence-based remediation.
- Use workflow URLs in the form `https://workflows.mctl.ai/workflows/{namespace}/{workflow_name}` when reporting progress.
