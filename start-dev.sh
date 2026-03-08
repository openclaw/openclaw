#!/usr/bin/env bash
# start-dev.sh
#
# 用法:
#   ./start-dev.sh                  # 启动 gateway（自动增量构建）
#   ./start-dev.sh gateway run      # 等同于 pnpm openclaw gateway run
#   ./start-dev.sh status           # 查看 channels 状态
#   ./start-dev.sh config set ...   # 修改配置
#
# 首次使用前请先运行:
#   pnpm install

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 检查 Node.js 版本 (需要 22+)
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "❌ 需要 Node.js 22+，当前版本: $(node -v)"
  exit 1
fi

# 检查 pnpm 是否可用
if ! command -v pnpm &>/dev/null; then
  echo "❌ 未找到 pnpm，请先安装: npm install -g pnpm"
  exit 1
fi

# 检查依赖是否已安装
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "📦 首次运行，安装依赖..."
  pnpm install --dir "$SCRIPT_DIR"
fi

# 停掉已有的 gateway 进程（避免端口冲突）
stop_existing_gateway() {
  local port="${OPENCLAW_GATEWAY_PORT:-18789}"
  local existing_pid
  existing_pid=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$existing_pid" ]; then
    echo "⚠️  检测到端口 $port 已被占用 (pid $existing_pid)，正在停止旧 gateway..."
    kill "$existing_pid" 2>/dev/null || true
    # 等待进程退出，最多 5 秒
    local waited=0
    while kill -0 "$existing_pid" 2>/dev/null && [ "$waited" -lt 50 ]; do
      sleep 0.1
      waited=$((waited + 1))
    done
    if kill -0 "$existing_pid" 2>/dev/null; then
      echo "⚠️  进程 $existing_pid 未响应 SIGTERM，发送 SIGKILL..."
      kill -9 "$existing_pid" 2>/dev/null || true
      sleep 0.5
    fi
    echo "✅ 旧 gateway 已停止"
  fi
}

# 默认启动 gateway
if [ $# -eq 0 ]; then
  stop_existing_gateway
  echo "🚀 从源码启动 OpenClaw gateway..."
  exec node "$SCRIPT_DIR/scripts/run-node.mjs" gateway run --force
else
  # gateway run 子命令也需要停掉旧进程
  if [ "$1" = "gateway" ] && { [ "${2:-}" = "run" ] || [ "${2:-}" = "" ]; }; then
    stop_existing_gateway
  fi
  exec node "$SCRIPT_DIR/scripts/run-node.mjs" "$@"
fi
