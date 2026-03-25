#!/bin/bash
# EVOX Research Engine - Parallel web fetching tool
# Usage: ./research-engine.sh <topic> <output_file>

TOPIC="$1"
OUTPUT="$2"
TEMP_DIR="/tmp/evox-research-$$"

mkdir -p "$TEMP_DIR"

# Function to fetch and extract content
fetch_url() {
    local url="$1"
    local output="$2"
    curl -sL --max-time 30 "$url" | \
        sed 's/<script[^>]*>.*<\/script>//g' | \
        sed 's/<style[^>]*>.*<\/style>//g' | \
        sed 's/<[^>]*>//g' | \
        tr -s ' \n' | \
        head -c 10000 > "$output"
}

# Parallel fetch from multiple sources
echo "🔍 Researching: $TOPIC"
echo "📁 Output: $OUTPUT"

# Create output header
cat > "$OUTPUT" << EOF
# Research Report: $TOPIC
Generated: $(date)
---

EOF

echo "✅ Research engine ready"
echo "Use with: fetch_url <url> <temp_file>"
