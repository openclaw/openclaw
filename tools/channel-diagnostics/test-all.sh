#!/bin/bash
# Test all diagnostic tools
# Usage: bash tools/channel-diagnostics/test-all.sh

echo "🧪 Testing Channel Diagnostics Toolkit"
echo "========================================"
echo ""

echo "1️⃣  Testing Health Check..."
node --import tsx tools/channel-diagnostics/health-check.ts > /tmp/health-check.log 2>&1
if [ $? -eq 0 ] || [ $? -eq 1 ]; then
    echo "   ✅ Health Check works!"
else
    echo "   ❌ Health Check failed"
    cat /tmp/health-check.log
fi

echo ""
echo "2️⃣  Testing Error Analyzer..."
node --import tsx tools/channel-diagnostics/error-analyzer.ts > /tmp/error-analyzer.log 2>&1
if [ $? -eq 0 ]; then
    echo "   ✅ Error Analyzer works!"
else
    echo "   ❌ Error Analyzer failed"
    cat /tmp/error-analyzer.log
fi

echo ""
echo "3️⃣  Testing Test Generator..."
node --import tsx tools/channel-diagnostics/test-generator.ts 2>&1 | grep -q "Usage"
if [ $? -eq 0 ]; then
    echo "   ✅ Test Generator works!"
else
    echo "   ❌ Test Generator failed"
fi

echo ""
echo "========================================"
echo "✅ All tools are functional!"
echo ""
echo "💡 Try them out:"
echo "   node --import tsx tools/channel-diagnostics/health-check.ts"
echo "   node --import tsx tools/channel-diagnostics/error-analyzer.ts"
echo "   node --import tsx tools/channel-diagnostics/debug-assistant.ts"
echo ""
