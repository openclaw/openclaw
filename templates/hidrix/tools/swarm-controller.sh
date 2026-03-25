#!/bin/bash
# EVOX Swarm Controller - Manage sub-agents
# Usage: ./swarm-controller.sh <action> [args]

ACTION="$1"
SWARM_DIR="/Users/sonpiaz/.openclaw/workspace/swarm"

case "$ACTION" in
    status)
        echo "📊 Swarm Status"
        echo "==============="
        if [ -d "$SWARM_DIR/results" ]; then
            echo "Results:"
            ls -la "$SWARM_DIR/results/" 2>/dev/null | grep -v "^total" | grep -v "^\." || echo "  (none yet)"
        fi
        if [ -d "$SWARM_DIR/tasks" ]; then
            echo ""
            echo "Tasks:"
            for task in "$SWARM_DIR/tasks"/*.md; do
                if [ -f "$task" ]; then
                    echo "  - $(basename "$task")"
                    grep -E "^\- \[.\]" "$task" 2>/dev/null | head -5
                fi
            done
        fi
        ;;
    
    results)
        echo "📄 Swarm Results"
        echo "================"
        for result in "$SWARM_DIR/results"/*.md; do
            if [ -f "$result" ]; then
                echo ""
                echo "=== $(basename "$result") ==="
                head -50 "$result"
            fi
        done
        ;;
    
    clean)
        echo "🧹 Cleaning swarm data..."
        rm -rf "$SWARM_DIR/results"/*.md
        echo "Done."
        ;;
    
    *)
        echo "Usage: $0 {status|results|clean}"
        exit 1
        ;;
esac
