"""
Tailscale Monitor — Network health and connectivity for OpenClaw bot.

Monitors Tailscale VPN status and provides:
  1. Tailnet connectivity check (is the node online?)
  2. Peer device monitoring (active/offline)
  3. /tailscale status command for Telegram

Uses 'tailscale' CLI (must be installed and running).
"""

import asyncio
import json
import shutil
from dataclasses import dataclass, field
from typing import Optional

import structlog

logger = structlog.get_logger("TailscaleMonitor")

# Tailscale CLI path detection
TAILSCALE_PATHS = [
    r"C:\Program Files\Tailscale\tailscale.exe",
    "tailscale",  # fallback to PATH
]


@dataclass
class TailscalePeer:
    hostname: str
    dns_name: str
    tailscale_ips: list[str]
    os: str
    online: bool
    last_seen: str = ""
    rx_bytes: int = 0
    tx_bytes: int = 0


@dataclass
class TailscaleStatus:
    connected: bool = False
    self_ip: str = ""
    self_dns: str = ""
    self_hostname: str = ""
    magic_dns_suffix: str = ""
    peers: list[TailscalePeer] = field(default_factory=list)
    error: str = ""
    backend_state: str = ""


class TailscaleMonitor:
    """Monitors Tailscale connectivity and provides network info for the bot."""

    def __init__(self, config: dict):
        self._config = config
        self._ts_cli = self._find_cli()
        self._last_status: Optional[TailscaleStatus] = None

        # Configuration from openclaw_config.json
        ts_cfg = config.get("tailscale", {})
        self.enabled = ts_cfg.get("enabled", True)
        self.health_interval = ts_cfg.get("health_interval_sec", 60)

    @staticmethod
    def _find_cli() -> str:
        """Find Tailscale CLI binary."""
        for path in TAILSCALE_PATHS:
            if shutil.which(path) or (len(path) > 10 and __import__("os").path.isfile(path)):
                return path
        return ""

    async def get_status(self) -> TailscaleStatus:
        """Get current Tailscale status via CLI."""
        if not self._ts_cli:
            return TailscaleStatus(error="Tailscale CLI not found")

        try:
            proc = await asyncio.create_subprocess_exec(
                self._ts_cli, "status", "--json",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)

            if proc.returncode != 0:
                return TailscaleStatus(
                    error=f"tailscale status failed: {stderr.decode().strip()}"
                )

            data = json.loads(stdout.decode())
            self_info = data.get("Self", {})
            peers_raw = data.get("Peer", {})

            status = TailscaleStatus(
                connected=self_info.get("Online", False),
                self_ip=self_info.get("TailscaleIPs", [""])[0],
                self_dns=self_info.get("DNSName", "").rstrip("."),
                self_hostname=self_info.get("HostName", ""),
                magic_dns_suffix=data.get("MagicDNSSuffix", ""),
                backend_state=data.get("BackendState", ""),
            )

            for _peer_id, peer_data in peers_raw.items():
                peer = TailscalePeer(
                    hostname=peer_data.get("HostName", ""),
                    dns_name=peer_data.get("DNSName", "").rstrip("."),
                    tailscale_ips=peer_data.get("TailscaleIPs", []),
                    os=peer_data.get("OS", ""),
                    online=peer_data.get("Online", False),
                    last_seen=peer_data.get("LastSeen", ""),
                    rx_bytes=peer_data.get("RxBytes", 0),
                    tx_bytes=peer_data.get("TxBytes", 0),
                )
                status.peers.append(peer)

            self._last_status = status
            return status

        except asyncio.TimeoutError:
            return TailscaleStatus(error="Tailscale CLI timeout (10s)")
        except json.JSONDecodeError as e:
            return TailscaleStatus(error=f"Invalid JSON from tailscale: {e}")
        except Exception as e:
            return TailscaleStatus(error=f"Tailscale error: {e}")

    async def check_connectivity(self) -> dict:
        """Quick connectivity check — is Tailscale up and are we online?"""
        status = await self.get_status()
        return {
            "tailscale_available": bool(self._ts_cli),
            "connected": status.connected,
            "backend_state": status.backend_state,
            "self_ip": status.self_ip,
            "self_dns": status.self_dns,
            "peers_online": sum(1 for p in status.peers if p.online),
            "peers_total": len(status.peers),
            "error": status.error,
        }

    async def ping_peer(self, hostname: str) -> dict:
        """Ping a Tailscale peer using tailscale ping."""
        if not self._ts_cli:
            return {"error": "Tailscale CLI not found"}

        try:
            proc = await asyncio.create_subprocess_exec(
                self._ts_cli, "ping", "--c", "1", "--timeout", "5s", hostname,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
            output = stdout.decode().strip()
            return {
                "success": proc.returncode == 0,
                "output": output,
                "peer": hostname,
            }
        except asyncio.TimeoutError:
            return {"success": False, "error": "Ping timeout", "peer": hostname}
        except Exception as e:
            return {"success": False, "error": str(e), "peer": hostname}

    def format_status_message(self, status: TailscaleStatus) -> str:
        """Format Tailscale status for Telegram /tailscale command."""
        if status.error:
            return f"⚠️ Tailscale: {status.error}"

        state_emoji = "🟢" if status.connected else "🔴"
        lines = [
            f"{state_emoji} <b>Tailscale Status</b>",
            f"├ State: <code>{status.backend_state}</code>",
            f"├ IP: <code>{status.self_ip}</code>",
            f"├ DNS: <code>{status.self_dns}</code>",
            f"├ Tailnet: <code>{status.magic_dns_suffix}</code>",
            f"└ Host: <code>{status.self_hostname}</code>",
        ]

        if status.peers:
            lines.append("")
            lines.append(f"📡 <b>Peers ({len(status.peers)})</b>")
            for peer in status.peers:
                emoji = "🟢" if peer.online else "⚪"
                ip = peer.tailscale_ips[0] if peer.tailscale_ips else "N/A"
                lines.append(
                    f"  {emoji} {peer.hostname} ({peer.os}) — <code>{ip}</code>"
                )

        return "\n".join(lines)
