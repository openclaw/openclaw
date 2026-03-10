#!/bin/bash
set -e

echo "Starting OpenClaw with GUI Desktop..."
echo "======================================"

# Set display
export DISPLAY=:99

# Configurable VNC password (default for local dev only)
VNC_PASSWORD="${VNC_PASSWORD:-openclaw}"

# Ensure VNC password is set
mkdir -p /root/.vnc
x11vnc -storepasswd "$VNC_PASSWORD" /root/.vnc/passwd

# Create workspace directory if not exists
mkdir -p /home/node/.openclaw/workspace
chown -R node:node /home/node/.openclaw

# Configure browser settings for container environment
# These must be set via config (env vars are not read by the gateway browser launcher)
su - node -c "openclaw config set browser.headless false"
if [ "$OPENCLAW_BROWSER_NO_SANDBOX" = "1" ]; then
  su - node -c "openclaw config set browser.noSandbox true"
fi

# Ensure XFCE4 panel config exists
mkdir -p /root/.config/xfce4
if [ ! -d /root/.config/xfce4-first-run ]; then
    touch /root/.config/xfce4-first-run
fi

echo "Services (container-internal ports):"
echo "  - OpenClaw Gateway: http://localhost:18789"
echo "  - VNC: localhost:5900 (password from VNC_PASSWORD env)"
echo "  - noVNC (Browser): http://localhost:6080"
echo ""
echo "Tip: The desktop panel appears at the top with the Applications menu."
echo ""

# Start supervisord (manages all services)
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
