#!/bin/bash
# Convert chat history timestamps to ISO format
# Usage: ./convert-timestamps.sh [file]
#
# Converts: **User** (Mar 20, 13:40): message
# To:       **User** (2026-03-20T13:40 PST): message

FILE="${1:-$HOME/.agents/cal/workspace/knowledge/chat-history/telegram/2026-03.md}"

if [ ! -f "$FILE" ]; then
  echo "File not found: $FILE"
  exit 1
fi

# Backup
cp "$FILE" "${FILE}.bak"

# Month name to number mapping
declare -A MONTHS=(
  ["Jan"]="01" ["Feb"]="02" ["Mar"]="03" ["Apr"]="04"
  ["May"]="05" ["Jun"]="06" ["Jul"]="07" ["Aug"]="08"
  ["Sep"]="09" ["Oct"]="10" ["Nov"]="11" ["Dec"]="12"
)

# Process file - convert (Mon DD, HH:MM) to (YYYY-MM-DDTHH:MM PST)
# Extract year from filename or use current year
YEAR=$(echo "$FILE" | grep -oE "20[0-9]{2}" | head -1)
[ -z "$YEAR" ] && YEAR=$(date +%Y)

# Use sed with extended regex
sed -E -i.tmp "
  s/\(Jan ([0-9]+), ([0-9:]+)\)/(${YEAR}-01-\1T\2 PST)/g
  s/\(Feb ([0-9]+), ([0-9:]+)\)/(${YEAR}-02-\1T\2 PST)/g
  s/\(Mar ([0-9]+), ([0-9:]+)\)/(${YEAR}-03-\1T\2 PST)/g
  s/\(Apr ([0-9]+), ([0-9:]+)\)/(${YEAR}-04-\1T\2 PST)/g
  s/\(May ([0-9]+), ([0-9:]+)\)/(${YEAR}-05-\1T\2 PST)/g
  s/\(Jun ([0-9]+), ([0-9:]+)\)/(${YEAR}-06-\1T\2 PST)/g
  s/\(Jul ([0-9]+), ([0-9:]+)\)/(${YEAR}-07-\1T\2 PST)/g
  s/\(Aug ([0-9]+), ([0-9:]+)\)/(${YEAR}-08-\1T\2 PST)/g
  s/\(Sep ([0-9]+), ([0-9:]+)\)/(${YEAR}-09-\1T\2 PST)/g
  s/\(Oct ([0-9]+), ([0-9:]+)\)/(${YEAR}-10-\1T\2 PST)/g
  s/\(Nov ([0-9]+), ([0-9:]+)\)/(${YEAR}-11-\1T\2 PST)/g
  s/\(Dec ([0-9]+), ([0-9:]+)\)/(${YEAR}-12-\1T\2 PST)/g
" "$FILE"

# Pad single-digit days with 0
sed -E -i.tmp2 's/\(([0-9]{4})-([0-9]{2})-([0-9])T/(\1-\2-0\3T/g' "$FILE"

# Cleanup temp files
rm -f "${FILE}.tmp" "${FILE}.tmp2"

echo "Converted timestamps in $FILE"
echo "Backup saved to ${FILE}.bak"

# Show sample
echo ""
echo "Sample output:"
head -10 "$FILE"
