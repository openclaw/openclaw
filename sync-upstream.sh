#!/usr/bin/env bash
# sync-upstream.sh — Sync feature branch with upstream openclaw
# Usage: ./sync-upstream.sh

set -e

FEATURE_BRANCH="feat/custom-user-data-dir"
UPSTREAM_REMOTE="upstream"
ORIGIN_REMOTE="origin"
MAIN_BRANCH="main"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
error()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── 1. Kiểm tra remotes ──────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Sync upstream → $FEATURE_BRANCH"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if ! git remote get-url "$UPSTREAM_REMOTE" &>/dev/null; then
  error "Remote '$UPSTREAM_REMOTE' không tồn tại. Chạy:\n  git remote add upstream https://github.com/openclaw/openclaw.git"
fi

if ! git remote get-url "$ORIGIN_REMOTE" &>/dev/null; then
  error "Remote '$ORIGIN_REMOTE' không tồn tại."
fi

# ── 2. Kiểm tra working tree sạch ───────────────────────────────────────────
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "Working tree có thay đổi chưa commit."
  read -p "  Stash lại và tiếp tục? (y/N) " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || error "Hủy. Hãy commit hoặc stash thủ công trước."
  git stash push -m "auto-stash before sync-upstream $(date '+%Y-%m-%d %H:%M:%S')"
  STASHED=true
fi

# ── 3. Fetch upstream ────────────────────────────────────────────────────────
info "Fetching từ $UPSTREAM_REMOTE..."
git fetch "$UPSTREAM_REMOTE"

# ── 4. Cập nhật main local ───────────────────────────────────────────────────
info "Cập nhật $MAIN_BRANCH local..."
git checkout "$MAIN_BRANCH"
git merge --ff-only "$UPSTREAM_REMOTE/$MAIN_BRANCH" || {
  warn "Không thể fast-forward main. Reset về upstream/main..."
  git reset --hard "$UPSTREAM_REMOTE/$MAIN_BRANCH"
}
git push "$ORIGIN_REMOTE" "$MAIN_BRANCH"
info "Đã sync $MAIN_BRANCH lên fork."

# ── 5. Rebase feature branch ─────────────────────────────────────────────────
info "Chuyển sang $FEATURE_BRANCH..."
git checkout "$FEATURE_BRANCH"

info "Rebase $FEATURE_BRANCH lên $UPSTREAM_REMOTE/$MAIN_BRANCH..."
if ! git rebase "$UPSTREAM_REMOTE/$MAIN_BRANCH"; then
  error "Rebase bị conflict. Giải quyết conflict rồi chạy:\n  git rebase --continue\n  git push $ORIGIN_REMOTE $FEATURE_BRANCH --force-with-lease"
fi

# ── 6. Push feature branch ───────────────────────────────────────────────────
info "Push $FEATURE_BRANCH lên fork..."
git push "$ORIGIN_REMOTE" "$FEATURE_BRANCH" --force-with-lease
info "Đã push $FEATURE_BRANCH lên $ORIGIN_REMOTE."

# ── 7. Khôi phục stash nếu có ───────────────────────────────────────────────
if [[ "${STASHED:-false}" == "true" ]]; then
  info "Khôi phục stash..."
  git stash pop
fi

# ── 8. Tóm tắt ──────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
UPSTREAM_VER=$(git show "$UPSTREAM_REMOTE/$MAIN_BRANCH":package.json 2>/dev/null | grep '"version"' | head -1 | sed 's/.*: "\(.*\)".*/\1/')
info "Upstream version: $UPSTREAM_VER"
info "Sync hoàn tất!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
