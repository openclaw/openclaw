#!/bin/bash
# 新功能开发脚本
# 基于daily-sync分支创建新功能分支

set -e

if [ -z "$1" ]; then
    echo "使用方法: $0 <功能名称>"
    echo "示例: $0 add-new-model-support"
    echo "示例: $0 fix-documentation"
    exit 1
fi

FEATURE_NAME=$1
BRANCH_NAME="feature-${FEATURE_NAME}"

echo "========================================="
echo "新功能开发: $FEATURE_NAME - $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "========================================="

# 配置
REPO_DIR="/root/.openclaw/workspace-github_expert/openclaw"
FEATURE_LOG="/root/.openclaw/workspace-github_expert/feature-${FEATURE_NAME}-$(date +%Y%m%d).log"

# 切换到仓库目录
cd "$REPO_DIR" || {
    echo "错误：无法进入仓库目录 $REPO_DIR"
    exit 1
}

# 函数：记录日志
log() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $1" | tee -a "$FEATURE_LOG"
}

# 1. 确保在daily-sync分支
log "步骤1: 切换到daily-sync分支..."
git checkout daily-sync
git pull origin daily-sync

# 2. 创建新功能分支
log "步骤2: 创建新功能分支: $BRANCH_NAME..."
git checkout -b "$BRANCH_NAME"

# 3. 显示当前状态
log "步骤3: 显示仓库状态..."
git status
echo ""
echo "当前分支: $(git branch --show-current)"
echo "基于分支: daily-sync"
echo "提交哈希: $(git rev-parse --short HEAD)"
echo ""

# 4. 提供开发指南
echo "========================================="
echo "开发指南"
echo "========================================="
echo "1. 你现在在分支: $BRANCH_NAME"
echo "2. 这个分支基于最新的 daily-sync 分支"
echo "3. 开始你的修改:"
echo "   - 编辑文件"
echo "   - 测试修改"
echo "   - 提交更改"
echo ""
echo "常用命令:"
echo "  git add <文件>              # 添加文件到暂存区"
echo "  git commit -m \"描述\"       # 提交更改"
echo "  git status                 # 查看状态"
echo "  git diff                   # 查看修改"
echo ""
echo "完成后运行:"
echo "  ./sync-scripts/create-pr.sh \"功能描述\""
echo "========================================="

# 5. 记录分支信息
log "新功能分支创建完成: $BRANCH_NAME"
log "基于提交: $(git rev-parse --short HEAD)"
log "创建时间: $(date)"

# 6. 创建分支说明文件
cat > "BRANCH-${BRANCH_NAME}.md" << EOF
# 功能分支: $BRANCH_NAME

## 基本信息
- **分支名称**: $BRANCH_NAME
- **基于分支**: daily-sync
- **创建时间**: $(date)
- **创建者**: GitHub Expert
- **目的**: $FEATURE_NAME

## 开发记录

### $(date '+%Y-%m-%d %H:%M:%S')
- 分支创建完成
- 基于 daily-sync 分支
- 提交哈希: $(git rev-parse --short HEAD)

## 修改计划
[在此描述计划修改的内容]

## 相关PR
[创建PR后更新]

## 状态
- [ ] 开发中
- [ ] 测试完成
- [ ] PR创建
- [ ] 合并完成
EOF

log "分支说明文件已创建: BRANCH-${BRANCH_NAME}.md"

echo ""
echo "✅ 新功能分支 $BRANCH_NAME 已准备就绪！"
echo "开始你的开发工作吧！ 🚀"

exit 0