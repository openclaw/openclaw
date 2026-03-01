# OpenClaw Windows Release

This directory contains the Windows distribution of OpenClaw Gateway with WinSW service wrapper.

## Contents

- `openclaw.exe` - OpenClaw CLI executable
- `openclaw-gateway.exe` - WinSW service wrapper (renamed from WinSW-x64.exe)
- `openclaw-gateway.xml` - WinSW configuration template
- `LICENSE` - MIT License

## Quick Start

### 1. Install as Windows Service (Recommended)

Run PowerShell as **Administrator**:

```powershell
# Navigate to the extracted folder
cd OpenClaw-windows-*

# Install and start the service
.\openclaw-gateway.exe install
.\openclaw-gateway.exe start

# Check service status
.\openclaw-gateway.exe status
```

### 2. Or use OpenClaw CLI

```powershell
# Install service via CLI
.\openclaw.exe service install

# Or with specific port
.\openclaw.exe service install --port 18789
```

## Service Management Commands

| Command | Description |
|---------|-------------|
| `.\openclaw-gateway.exe install` | Install as Windows service |
| `.\openclaw-gateway.exe uninstall` | Remove Windows service |
| `.\openclaw-gateway.exe start` | Start the service |
| `.\openclaw-gateway.exe stop` | Stop the service |
| `.\openclaw-gateway.exe restart` | Restart the service |
| `.\openclaw-gateway.exe status` | Check service status |

## Log Files

- Service logs: `%PROGRAMDATA%\OpenClaw\logs\`
- Or check Windows Event Viewer

## Non-Admin Installation (Task Scheduler)

If you don't have admin rights, use Task Scheduler mode:

```powershell
.\openclaw.exe service install --mode user
```

## Troubleshooting

### Service won't start

1. Check logs in `%PROGRAMDATA%\OpenClaw\logs\`
2. Run as Administrator for the first time
3. Check Windows Event Viewer > Windows Logs > Application

### Access Denied

Run PowerShell as Administrator:

```powershell
Start-Process powershell -Verb RunAs
```

## Version Information

- OpenClaw: See `openclaw.exe --version`
- WinSW: v2.12.0 (MIT License)

## License

See LICENSE file for OpenClaw and WinSW license information.
