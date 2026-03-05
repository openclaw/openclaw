#!/bin/bash

whoami
echo $(pwd)

# 是否使用 juicefs 挂载
if [ -n "${juicefs-dir}" ]; then
    echo "检测到 juicefs-dir 环境变量，将挂载 juicefs"
    RUN /usr/local/bin/juicefs mount ${juicefs-dir} ~/.openclaw
    # 检查是否挂载成功
    if [ $? -eq 0 ]; then
        echo "juicefs 已成功挂载到 ~/.openclaw"
    else
        echo "juicefs 挂载失败，请检查 token 是否正确。"
        exit 1
    fi
else
    echo "未提供 juicefs-dir 环境变量，将不挂载 juicefs"
fi

# 运行 openclaw
node openclaw.mjs gateway --allow-unconfigured
